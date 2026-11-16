#!/usr/bin/env python3
"""
Convert an Enshrouded world .ksd file into human-readable JSON.

Usage:
    python ksd_to_json.py world0.ksd [out.json] [--dump-raw DIR] [--compact]

What you get
    * container header + chunk directory (every chunk's name, offset, size, type,
      compression flag, stored checksum)
    * FULLY decoded:   "logic"          -> Sparkworks graphs (nodes, edges, positions)
                       "custom_strings" -> player/dungeon-assigned names (key -> text)
    * PARTLY decoded:  "world_metadata" -> world id, timestamp, world name
    * everything else  -> size, entropy, readable strings, first bytes in hex.
      Use --dump-raw DIR to write every chunk's payload (decompressed when
      possible) to DIR/<name>.bin for further reverse engineering.

zstd: three chunks (entity_chunk00, snapping, world_knowledge) are zstd-compressed.
To decompress them this script uses, in order, Python 3.14's `compression.zstd`,
the `zstandard` package, or `pyzstd` (`pip install zstandard`). If none is present
those chunks are still listed, but their contents are not inspected.

Everything here was reverse-engineered from a single save file. Fields marked
"(?)" in comments are guesses; anything not decoded is left as raw hex, never
invented.
"""
import argparse
import collections
import json
import math
import os
import re
import struct
import sys
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def iso(ts):
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def entropy(b):
    """Shannon entropy (bits/byte) of up to the first 64 KiB."""
    b = b[:65536]
    if not b:
        return 0.0
    n = len(b)
    return round(-sum(v / n * math.log2(v / n) for v in collections.Counter(b).values()), 2)


def strings(b, minlen=6, limit=25):
    found = re.findall(rb"[\x20-\x7e]{%d,}" % minlen, b)
    out, seen = [], set()
    for s in found:
        t = s.decode("ascii")
        # keep only text-like runs (mostly letters/digits/space), drop symbol soup
        if sum(ch.isalnum() or ch in " _-.'" for ch in t) < 0.8 * len(t):
            continue
        if t not in seen:
            seen.add(t)
            out.append(t)
        if len(out) >= limit:
            break
    return out


class ZstdUnavailable(Exception):
    pass


def zstd_decompress(data):
    try:  # Python 3.14+
        from compression import zstd  # type: ignore
        return zstd.decompress(data)
    except ImportError:
        pass
    try:
        import zstandard  # type: ignore
        return zstandard.ZstdDecompressor().decompressobj().decompress(data)
    except ImportError:
        pass
    try:
        import pyzstd  # type: ignore
        return pyzstd.decompress(data)
    except ImportError:
        pass
    raise ZstdUnavailable("no zstd library found (pip install zstandard)")


# --------------------------------------------------------------------------
# container + chunk framing
# --------------------------------------------------------------------------
#
# Container header ("SV2C"), 48 bytes:
#   0x00 'SV2C'   0x04 u16 version   0x06 u16 header size   0x08 u32 file size
#   0x0c 16-byte world id   0x1c u32 (?)   0x20 u64 unix timestamp
#   0x28 u32 footer offset  0x2c u32 chunk count
# Footer = 40 zero bytes + N 20-byte directory entries
#   <u32 rel_name_offset, u32 name_len, u32 offset, u32 size, u32 checksum>
# + the concatenated names.
#
# Chunk ("S2BH"), 14-byte header then payload:
#   'S2BH'  u32 format version(=2)  u16 type (low byte = type id,
#   high byte 0x01 = zstd-compressed payload)  u32 chunk schema version

CHUNK_HEADER = 14


def parse_container(d):
    magic, ver, hdr, fsize = struct.unpack_from("<4sHHI", d, 0)
    if magic != b"SV2C":
        raise ValueError("not an SV2C/.ksd container (magic=%r)" % magic)
    world_id = d[0x0C:0x1C].hex()
    unk = struct.unpack_from("<I", d, 0x1C)[0]
    ts = struct.unpack_from("<Q", d, 0x20)[0]
    footer_off, count = struct.unpack_from("<II", d, 0x28)
    entries = []
    p = footer_off + 40
    for i in range(count):
        rel, nlen, off, sz, crc = struct.unpack_from("<5I", d, p + 20 * i)
        name = d[p + 20 * i + rel: p + 20 * i + rel + nlen].decode("utf-8", "replace")
        entries.append((name, off, sz, crc))
    header = {
        "magic": "SV2C",
        "version": ver,
        "header_size": hdr,
        "file_size_field": fsize,
        "file_size_actual": len(d),
        "world_id": world_id,
        "unknown_u32_at_0x1c": unk,
        "timestamp_unix": ts,
        "timestamp_utc": iso(ts),
        "footer_offset": footer_off,
        "chunk_count": count,
    }
    return header, entries


# --------------------------------------------------------------------------
# per-chunk decoders
# --------------------------------------------------------------------------

# Sparkworks node: u32 id, f32 x, f32 y, u8 type, u8 has_extra, extra bytes.
EXTRA_LEN = {0: 4, 1: 8, 2: 8, 10: 16, 11: 1, 12: 1}


def decode_logic(p):
    """Sparkworks graphs. Payload = u32 byte-length, u32 version(6), u32 graph count, graphs."""
    warnings = []
    declared = struct.unpack_from("<I", p, 0)[0]
    if declared != len(p) - 4:
        warnings.append(f"length field {declared} != actual {len(p) - 4}")
    version, ngraphs = struct.unpack_from("<II", p, 4)
    pos = 12
    graphs = []
    for gi in range(ngraphs):
        graph_id = p[pos:pos + 13].hex()          # (?) 13-byte id
        pos += 13
        ts = struct.unpack_from("<Q", p, pos)[0]
        pos += 8
        n = struct.unpack_from("<I", p, pos)[0]
        pos += 4
        nodes = []
        for _ in range(n):
            nid = p[pos:pos + 4].hex()
            x, y = struct.unpack_from("<ff", p, pos + 4)
            t, has = p[pos + 12], p[pos + 13]
            ln = 0
            if has:
                if t not in EXTRA_LEN:
                    raise ValueError(
                        f"unknown extra-data length for node type {t} at payload offset 0x{pos:x}")
                ln = EXTRA_LEN[t]
            nodes.append({"id": nid, "x": round(x, 3), "y": round(y, 3), "type": t,
                          "extra": p[pos + 14:pos + 14 + ln].hex()})
            pos += 14 + ln
        m = struct.unpack_from("<I", p, pos)[0]
        pos += 4
        edges = []
        for _ in range(m):
            edges.append({"from": p[pos:pos + 4].hex(), "to": p[pos + 4:pos + 8].hex(),
                          "flag": struct.unpack_from("<H", p, pos + 8)[0]})
            pos += 10
        ids = {nd["id"] for nd in nodes}
        dangling = sum(1 for e in edges if e["from"] not in ids or e["to"] not in ids)
        if dangling:
            warnings.append(f"graph {gi}: {dangling} edges reference unknown node ids")
        graphs.append({"index": gi, "graph_id": graph_id, "timestamp_unix": ts,
                       "timestamp_utc": iso(ts), "node_count": n, "edge_count": m,
                       "nodes": nodes, "edges": edges})
    out = {
        "format": "sparkworks graphs",
        "version": version,
        "graph_count": ngraphs,
        "graphs": graphs,
        # Bytes after the graph list; looks like a per-graph table (?), not decoded.
        "unparsed_trailer_bytes": len(p) - pos,
        "unparsed_trailer_hex": p[pos:].hex(),
    }
    if warnings:
        out["warnings"] = warnings
    return out


def decode_custom_strings(p):
    """u32 count, then count x (8-byte key, u32 length, utf-8 text)."""
    n = struct.unpack_from("<I", p, 0)[0]
    pos = 4
    items = []
    for _ in range(n):
        key = p[pos:pos + 8].hex()
        ln = struct.unpack_from("<I", p, pos + 8)[0]
        pos += 12
        items.append({"key": key, "text": p[pos:pos + ln].decode("utf-8", "replace")})
        pos += ln
    out = {"format": "custom strings (names assigned to entities)", "count": n, "entries": items}
    if pos != len(p):
        out["warnings"] = [f"{len(p) - pos} unparsed trailing bytes"]
    return out


def decode_world_metadata(p):
    """Partly understood. Offsets verified on one file only."""
    out = {"format": "world metadata (partial)", "world_id": p[0:16].hex()}
    ts = struct.unpack_from("<Q", p, 0x2D)[0]      # same value as the container timestamp
    out["timestamp_unix"] = ts
    out["timestamp_utc"] = iso(ts)
    ln = struct.unpack_from("<I", p, 0x39)[0]
    if 0 < ln < 256:
        out["world_name"] = p[0x3D:0x3D + ln].decode("utf-8", "replace")
        rest = 0x3D + ln
    else:
        rest = 0x39
    out["unparsed_hex"] = p[rest:].hex()
    return out


DECODERS = {
    "logic": decode_logic,
    "custom_strings": decode_custom_strings,
    "world_metadata": decode_world_metadata,
}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def convert(d, dump_dir=None):
    header, entries = parse_container(d)
    chunks = []
    for name, off, sz, crc in sorted(entries, key=lambda e: e[1]):
        raw = d[off:off + sz]
        info = {"name": name, "offset": off, "size": sz, "checksum_stored": f"{crc:08x}"}
        if raw[:4] != b"S2BH":
            info["error"] = f"bad chunk magic {raw[:4]!r}"
            chunks.append(info)
            continue
        cver, traw, schema = struct.unpack_from("<IHI", raw, 4)
        compressed = bool(traw >> 8 & 1)
        info.update({"chunk_format_version": cver, "type_id": traw & 0xFF,
                     "compressed_zstd": compressed, "schema_version": schema})
        payload = raw[CHUNK_HEADER:]
        info["payload_size"] = len(payload)

        if compressed:
            try:
                payload = zstd_decompress(payload)
                info["decompressed_size"] = len(payload)
            except ZstdUnavailable as e:
                info["note"] = f"zstd payload not inspected: {e}"
                payload = None
            except Exception as e:  # corrupt frame etc.
                info["note"] = f"zstd decompression failed: {e}"
                payload = None

        if payload is not None:
            info["entropy_bits_per_byte"] = entropy(payload)
            if payload[:4] == b"SBV2":
                info["inner_magic"] = "SBV2 (nested container, not decoded)"
            if name in DECODERS:
                try:
                    info["decoded"] = DECODERS[name](payload)
                except Exception as e:
                    info["decode_error"] = f"{type(e).__name__}: {e}"
            if "decoded" not in info:
                info["status"] = "not decoded"
                # Strings from random-looking (compressed/packed) data are just noise.
                s = strings(payload, minlen=8) if info["entropy_bits_per_byte"] < 6.0 else []
                if s:
                    info["readable_strings"] = s
                info["first_64_bytes_hex"] = payload[:64].hex()
            if dump_dir:
                os.makedirs(dump_dir, exist_ok=True)
                with open(os.path.join(dump_dir, name + ".bin"), "wb") as f:
                    f.write(payload)
        chunks.append(info)
    return {"container": header, "chunks": chunks}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("ksd")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--dump-raw", metavar="DIR",
                    help="also write each chunk's (decompressed) payload to DIR/<name>.bin")
    ap.add_argument("--compact", action="store_true", help="no indentation")
    a = ap.parse_args()

    with open(a.ksd, "rb") as f:
        data = f.read()
    result = {"source_file": os.path.basename(a.ksd), **convert(data, a.dump_raw)}
    out = a.out or os.path.splitext(a.ksd)[0] + ".json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=None if a.compact else 1, ensure_ascii=False)

    print(f"wrote {out}")
    for c in result["chunks"]:
        if "decoded" in c:
            status = "decoded"
        elif "note" in c:
            status = "skipped"
        else:
            status = c.get("status", c.get("error", "?"))
        extra = f"  [{c['note']}]" if "note" in c else ""
        print(f"  {c['name']:24s} {c['size']:>8} bytes  {status}{extra}")


if __name__ == "__main__":
    main()
