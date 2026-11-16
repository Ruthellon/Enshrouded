/**
 * Extract Sparkworks (logic) graphs from an Enshrouded world .ksd file.
 *
 * Pure TypeScript: no Node APIs, no Buffer, no dependencies. It takes raw bytes
 * (Uint8Array or ArrayBuffer) and returns plain objects, so it runs unchanged in
 * the browser, Node, Deno, Bun, or a web worker.
 *
 * Browser example:
 *   const bytes = new Uint8Array(await fileInput.files![0].arrayBuffer());
 *   const { graphs } = parseKsd(bytes);
 *
 * Reverse-engineered from a single save file; field meanings marked (?) are guesses.
 *
 * Container ("SV2C"):
 *   0x00  'SV2C', u16 version=2, u16 header_size=48, u32 file_size, ...
 *   0x28  u32 footer_offset, u32 chunk_count
 *   footer = 40 zero bytes, then N directory entries of 20 bytes:
 *     <u32 rel_name_offset, u32 name_len, u32 offset, u32 size, u32 crc>
 *   followed by the concatenated chunk names.
 * Chunk ("S2BH"): 'S2BH', u32 version=2, u16 type, u16 flags, u32 payload_size, payload
 *   (some chunks, e.g. entity_chunk00, are zstd-compressed; 'logic' is not).
 *
 * 'logic' payload:
 *   u32 version(6), u32 graph_count
 *   per graph:
 *     13 bytes  graph id (?)
 *     u64       unix timestamp
 *     u32       node_count
 *     nodes:    u32 id, f32 x, f32 y, u8 type, u8 has_extra, extra bytes
 *               extra length when has_extra: {0:4, 1:8, 2:8, 10:16, 11:1, 12:1}
 *     u32       edge_count
 *     edges:    u32 from_id, u32 to_id, u16 flag
 */

export interface SparkNode {
  id: string; // 4-byte id as hex, in file byte order
  x: number;
  y: number;
  type: number;
  extra: string; // hex of the type-dependent extra bytes ("" if none)
}

export interface SparkEdge {
  from: string;
  to: string;
  flag: number;
}

export interface SparkGraph {
  index: number;
  graph_id: string;
  timestamp: number; // unix seconds
  nodes: SparkNode[];
  edges: SparkEdge[];
}

export interface ParseResult {
  graphs: SparkGraph[];
  /** Bytes left in the 'logic' chunk after the graph list (unparsed). */
  trailingBytes: number;
}

const EXTRA_LEN: Readonly<Record<number, number>> = { 0: 4, 1: 8, 2: 8, 10: 16, 11: 1, 12: 1 };

const CHUNK_HEADER_SIZE = 18; // 'S2BH' + u32 ver + u16 type + u16 flags + u32 size

/** Little-endian reader over a byte window. */
class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }
  u8(o: number): number {
    return this.view.getUint8(o);
  }
  u16(o: number): number {
    return this.view.getUint16(o, true);
  }
  u32(o: number): number {
    return this.view.getUint32(o, true);
  }
  u64(o: number): number {
    return Number(this.view.getBigUint64(o, true));
  }
  f32(o: number): number {
    return this.view.getFloat32(o, true);
  }
  hex(o: number, len: number): string {
    let s = "";
    for (let i = o; i < o + len; i++) s += this.bytes[i].toString(16).padStart(2, "0");
    return s;
  }
  text(o: number, len: number): string {
    return new TextDecoder("utf-8").decode(this.bytes.subarray(o, o + len));
  }
  slice(o: number, end: number): Reader {
    return new Reader(this.bytes.subarray(o, end));
  }
}

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function readDirectory(
  data: Uint8Array | ArrayBuffer
): Map<string, { offset: number; size: number }> {
  const d = new Reader(toBytes(data));
  if (d.text(0, 4) !== "SV2C") throw new Error("not an SV2C container");
  const footerOff = d.u32(0x28);
  const count = d.u32(0x2c);
  const p = footerOff + 40;
  const out = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < count; i++) {
    const e = p + 20 * i;
    const rel = d.u32(e);
    const nameLen = d.u32(e + 4);
    const offset = d.u32(e + 8);
    const size = d.u32(e + 12);
    // e + 16 is a checksum (unused)
    out.set(d.text(e + rel, nameLen), { offset, size });
  }
  return out;
}

export function parseLogic(data: Uint8Array | ArrayBuffer): { graphs: SparkGraph[]; end: number } {
  const c = new Reader(toBytes(data));
  const ngraphs = c.u32(4); // c.u32(0) is the version (6)
  let p = 8;
  const graphs: SparkGraph[] = [];

  for (let gi = 0; gi < ngraphs; gi++) {
    const graph_id = c.hex(p, 13);
    p += 13;
    const timestamp = c.u64(p);
    p += 8;
    const n = c.u32(p);
    p += 4;

    const nodes: SparkNode[] = [];
    for (let i = 0; i < n; i++) {
      const id = c.hex(p, 4);
      const x = c.f32(p + 4);
      const y = c.f32(p + 8);
      const type = c.u8(p + 12);
      const hasExtra = c.u8(p + 13) !== 0;
      let len = 0;
      if (hasExtra) {
        const known = EXTRA_LEN[type];
        if (known === undefined) {
          throw new Error(
            `Unknown extra-data length for node type ${type} at payload offset 0x${p.toString(16)}`
          );
        }
        len = known;
      }
      nodes.push({ id, x, y, type, extra: c.hex(p + 14, len) });
      p += 14 + len;
    }

    const m = c.u32(p);
    p += 4;
    const edges: SparkEdge[] = [];
    for (let i = 0; i < m; i++) {
      edges.push({ from: c.hex(p, 4), to: c.hex(p + 4, 4), flag: c.u16(p + 8) });
      p += 10;
    }

    graphs.push({ index: gi, graph_id, timestamp, nodes, edges });
  }
  return { graphs, end: p };
}

/** Parse the Sparkworks graphs out of the raw bytes of a .ksd file. */
export function parseKsd(data: Uint8Array | ArrayBuffer): ParseResult {
  const bytes = toBytes(data);
  const entry = readDirectory(bytes).get("logic");
  if (!entry) throw new Error("no 'logic' chunk found in this file");
  const payload = bytes.subarray(entry.offset + CHUNK_HEADER_SIZE, entry.offset + entry.size);
  const { graphs, end } = parseLogic(payload);
  return { graphs, trailingBytes: payload.length - end };
}
