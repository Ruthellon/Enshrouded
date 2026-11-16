#!/usr/bin/env python3
"""
Extract Sparkworks (logic) graphs from an Enshrouded world .ksd file.

Usage:  python parse_ksd_logic.py world0.ksd [out.json]

Reverse-engineered from a single save file; field meanings marked (?) are guesses.

Container ("SV2C"):
  0x00  'SV2C', u16 version=2, u16 header_size=48, u32 file_size, ...
  footer (at the offset stored in the header) = 40 zero bytes, then N directory
  entries of 20 bytes: <u32 rel_name_offset, u32 name_len, u32 offset, u32 size, u32 crc>
  followed by the concatenated chunk names.
Chunk ("S2BH"): 'S2BH', u32 version=2, u16 type, u16 flags, u32 payload_size, payload
  (some chunks, e.g. entity_chunk00, are zstd-compressed; 'logic' is not).

'logic' payload:
  u32 version(6), u32 graph_count
  per graph:
    13 bytes  graph id (?)
    u64       unix timestamp
    u32       node_count
    nodes:    u32 id, f32 x, f32 y, u8 type, u8 has_extra, extra bytes
              extra length when has_extra: {0:4, 1:8, 2:8, 10:16, 11:1, 12:1}
    u32       edge_count
    edges:    u32 from_id, u32 to_id, u16 flag
"""
import json
import struct
import sys

EXTRA_LEN = {0: 4, 1: 8, 2: 8, 10: 16, 11: 1, 12: 1}


def read_directory(d):
    magic, ver, hdr, size = struct.unpack_from("<4sHHI", d, 0)
    assert magic == b"SV2C", "not an SV2C container"
    footer_off, count = struct.unpack_from("<II", d, 0x28)
    p = footer_off + 40
    out = {}
    for i in range(count):
        rel, nlen, off, sz, crc = struct.unpack_from("<5I", d, p + 20 * i)
        name = d[p + 20 * i + rel : p + 20 * i + rel + nlen].decode()
        out[name] = (off, sz)
    return out


def parse_logic(c):
    ver, ngraphs = struct.unpack_from("<II", c, 0)
    p = 8
    graphs = []
    for gi in range(ngraphs):
        gid = c[p : p + 13].hex()
        p += 13
        ts = struct.unpack_from("<Q", c, p)[0]
        p += 8
        n = struct.unpack_from("<I", c, p)[0]
        p += 4
        nodes = []
        for _ in range(n):
            nid = c[p : p + 4].hex()
            x, y = struct.unpack_from("<ff", c, p + 4)
            t, has = c[p + 12], c[p + 13]
            L = EXTRA_LEN[t] if has else 0
            extra = c[p + 14 : p + 14 + L].hex()
            nodes.append({"id": nid, "x": x, "y": y, "type": t, "extra": extra})
            p += 14 + L
        m = struct.unpack_from("<I", c, p)[0]
        p += 4
        edges = []
        for _ in range(m):
            a, b = c[p : p + 4].hex(), c[p + 4 : p + 8].hex()
            flag = struct.unpack_from("<H", c, p + 8)[0]
            edges.append({"from": a, "to": b, "flag": flag})
            p += 10
        graphs.append({"index": gi, "graph_id": gid, "timestamp": ts,
                       "nodes": nodes, "edges": edges})
    return graphs, p


def main():
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else "sparkworks_graphs.json"
    d = open(src, "rb").read()
    off, sz = read_directory(d)["logic"]
    payload = d[off + 18 : off + sz]  # skip 18-byte S2BH header
    graphs, end = parse_logic(payload)
    json.dump(graphs, open(dst, "w"), indent=1)
    print(f"{len(graphs)} graphs, "
          f"{sum(len(g['nodes']) for g in graphs)} nodes, "
          f"{sum(len(g['edges']) for g in graphs)} edges -> {dst}")
    print(f"{len(payload) - end} trailing bytes after the graph list (unparsed)")


if __name__ == "__main__":
    main()
