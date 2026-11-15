/**
 * Reading and writing the Sparkworks ("logic") chunk of an Enshrouded .ksd world file.
 *
 * Each chunk's directory entry stores a checksum: the low 32 bits of XXH3-64 over the chunk's
 * complete bytes (header included). The game refuses files whose checksums do not match, so a
 * rebuilt file must recompute it (see buildKsd).
 *
 * Pure TypeScript with no Angular or Node dependencies, so it can be unit-tested on its own.
 * Reverse-engineered from a single save file; see README.md for what is and is not known.
 *
 * Container ("SV2C"):
 *   0x00 'SV2C'  0x04 u16 version  0x06 u16 header size  0x08 u32 file size
 *   0x28 u32 footer offset  0x2c u32 chunk count
 *   footer = 40 zero bytes + N x 20-byte directory entries
 *            <u32 rel_name_offset, u32 name_len, u32 offset, u32 size, u32 checksum>
 *            + concatenated chunk names
 * Chunk ("S2BH"): 'S2BH', u32 format version, u16 type (high byte 1 = zstd), u32 schema
 *                 version (14-byte header) followed by the payload.
 * "logic" payload:
 *   u32 byte length of the rest, u32 version (6), u32 graph count, then per graph:
 *     13 bytes id, u64 timestamp, u32 node count,
 *     nodes: u32 id, f32 x, f32 y, u8 type, u8 hasExtra, extra bytes (length depends on type)
 *     u32 edge count, edges: u32 from, u32 to, u16 flag
 *   followed by a trailer table that is preserved verbatim.
 */

import { xxh3Low32 } from './xxh3';

export class KsdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KsdError';
  }
}

export interface SparkNode {
  /** 4-byte node id as lowercase hex (file byte order). */
  id: string;
  x: number;
  y: number;
  /** Node type number. The game-side meaning of each number is not known. */
  type: number;
  /** Raw "has extra data" byte (0 = no extra bytes). */
  hasExtra: number;
  /** Type-dependent extra bytes as hex ('' when none). Preserved verbatim. */
  extra: string;
}

export interface SparkEdge {
  from: string;
  to: string;
  /**
   * Raw u16 after the endpoints. Its high byte selects the input connection on the target node:
   * 0 = UPPER (or the only input), 1 = LOWER (confirmed in the game). The low byte has only ever
   * been 0 and is preserved as is.
   */
  flag: number;
}

export interface SparkGraph {
  /** 13-byte id as hex. Preserved verbatim. */
  graphId: string;
  /** u64 timestamp as 8 bytes of hex. Preserved verbatim. */
  timestampHex: string;
  nodes: SparkNode[];
  edges: SparkEdge[];
}

export interface LogicData {
  version: number;
  graphs: SparkGraph[];
  /** Bytes after the graph list, preserved verbatim (purpose unknown). */
  trailer: Uint8Array;
}

export interface DirEntry {
  name: string;
  offset: number;
  size: number;
  checksum: number;
  /** Position of this entry within the directory. */
  dirIndex: number;
}

export interface ContainerInfo {
  version: number;
  headerSize: number;
  fileSize: number;
  footerOffset: number;
  chunkCount: number;
  worldId: string;
}

export interface ParsedKsd {
  bytes: Uint8Array;
  container: ContainerInfo;
  entries: DirEntry[];
  logicEntry: DirEntry;
  logicPayload: Uint8Array;
  logic: LogicData;
  /** Player-assigned names from the "custom_strings" chunk: 8-byte key (hex) -> text. */
  customStrings: Map<string, string>;
}

/** Names of chunks whose stored checksum does not match their bytes (empty for a healthy file). */
export function checksumMismatches(parsed: Pick<ParsedKsd, 'bytes' | 'entries'>): string[] {
  return parsed.entries
    .filter((e) => chunkChecksum(parsed.bytes.subarray(e.offset, e.offset + e.size)) !== e.checksum)
    .map((e) => e.name);
}

/** Extra-data length per node type when the node's hasExtra byte is non-zero. */
export const EXTRA_LEN: Readonly<Record<number, number>> = {
  0: 4,
  1: 8,
  2: 8,
  10: 16,
  11: 1,
  12: 1,
};

export const CHUNK_HEADER_SIZE = 14;

/** The checksum the directory stores for a chunk: low 32 bits of XXH3-64 over its whole bytes. */
export function chunkChecksum(chunk: Uint8Array): number {
  return xxh3Low32(chunk);
}
const DIR_FOOTER_PAD = 40;
const DIR_ENTRY_SIZE = 20;

// ---------------------------------------------------------------- helpers

export function bytesToHex(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new KsdError(`bad hex string "${hex}"`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function ascii(b: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len; i++) s += String.fromCharCode(b[i]);
  return s;
}

function need(buf: Uint8Array, pos: number, len: number, what: string): void {
  if (pos < 0 || pos + len > buf.length) {
    throw new KsdError(`file is truncated or corrupt: cannot read ${what} at byte ${pos}`);
  }
}

// ---------------------------------------------------------------- container

export function parseKsd(input: ArrayBuffer | Uint8Array): ParsedKsd {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  need(bytes, 0, 0x30, 'file header');
  if (ascii(bytes, 0, 4) !== 'SV2C') {
    throw new KsdError('This does not look like an Enshrouded .ksd file (missing "SV2C" header).');
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const container: ContainerInfo = {
    version: v.getUint16(4, true),
    headerSize: v.getUint16(6, true),
    fileSize: v.getUint32(8, true),
    worldId: bytesToHex(bytes, 0x0c, 0x1c),
    footerOffset: v.getUint32(0x28, true),
    chunkCount: v.getUint32(0x2c, true),
  };
  if (container.fileSize !== bytes.length) {
    throw new KsdError(
      `Header says the file is ${container.fileSize} bytes but it is ${bytes.length}. The file may be truncated.`,
    );
  }
  const dirStart = container.footerOffset + DIR_FOOTER_PAD;
  need(bytes, dirStart, DIR_ENTRY_SIZE * container.chunkCount, 'chunk directory');

  const entries: DirEntry[] = [];
  for (let i = 0; i < container.chunkCount; i++) {
    const e = dirStart + DIR_ENTRY_SIZE * i;
    const rel = v.getUint32(e, true);
    const nameLen = v.getUint32(e + 4, true);
    need(bytes, e + rel, nameLen, 'chunk name');
    const offset = v.getUint32(e + 8, true);
    const size = v.getUint32(e + 12, true);
    need(bytes, offset, size, 'chunk data');
    entries.push({
      name: ascii(bytes, e + rel, nameLen),
      offset,
      size,
      checksum: v.getUint32(e + 16, true),
      dirIndex: i,
    });
  }

  const logicEntry = entries.find((e) => e.name === 'logic');
  if (!logicEntry) throw new KsdError('No "logic" (Sparkworks) chunk found in this file.');
  if (ascii(bytes, logicEntry.offset, 4) !== 'S2BH') {
    throw new KsdError('The logic chunk has an unexpected header.');
  }
  const typeRaw = v.getUint16(logicEntry.offset + 8, true);
  if ((typeRaw >> 8) & 1) {
    throw new KsdError('The logic chunk is compressed, which this editor does not support.');
  }
  const logicPayload = bytes.subarray(logicEntry.offset + CHUNK_HEADER_SIZE, logicEntry.offset + logicEntry.size);
  const logic = parseLogicPayload(logicPayload);
  const customStrings = readCustomStrings(bytes, entries);
  return { bytes, container, entries, logicEntry, logicPayload, logic, customStrings };
}

// ---------------------------------------------------------------- names

/**
 * Read the "custom_strings" chunk: u32 count, then count x (8-byte key, u32 length, UTF-8 text).
 * Names are optional, so any problem here yields an empty map instead of blocking the file.
 */
export function readCustomStrings(bytes: Uint8Array, entries: DirEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const e = entries.find((x) => x.name === 'custom_strings');
    if (!e || ascii(bytes, e.offset, 4) !== 'S2BH') return out;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if ((v.getUint16(e.offset + 8, true) >> 8) & 1) return out; // compressed: not handled
    const start = e.offset + CHUNK_HEADER_SIZE;
    const end = e.offset + e.size;
    const count = v.getUint32(start, true);
    const dec = new TextDecoder('utf-8');
    let p = start + 4;
    for (let i = 0; i < count; i++) {
      if (p + 12 > end) break;
      const key = bytesToHex(bytes, p, p + 8);
      const len = v.getUint32(p + 8, true);
      p += 12;
      if (p + len > end) break;
      out.set(key, dec.decode(bytes.subarray(p, p + len)));
      p += len;
    }
  } catch {
    /* names are optional */
  }
  return out;
}

/**
 * A graph's 13-byte id is a 5-byte prefix followed by an 8-byte key. That key is the same key
 * used in custom_strings, which is where the graph's in-game name is stored.
 */
export function graphKey(graph: SparkGraph): string {
  return graph.graphId.slice(10);
}

export function graphName(parsed: Pick<ParsedKsd, 'customStrings'>, graph: SparkGraph): string | null {
  return parsed.customStrings.get(graphKey(graph)) ?? null;
}

// ---------------------------------------------------------------- logic payload

export function parseLogicPayload(p: Uint8Array): LogicData {
  need(p, 0, 12, 'logic header');
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const declared = v.getUint32(0, true);
  if (declared !== p.length - 4) {
    throw new KsdError(`Logic chunk length field (${declared}) does not match its size (${p.length - 4}).`);
  }
  const version = v.getUint32(4, true);
  const ngraphs = v.getUint32(8, true);
  let pos = 12;
  const graphs: SparkGraph[] = [];

  for (let gi = 0; gi < ngraphs; gi++) {
    need(p, pos, 13 + 8 + 4, `graph ${gi} header`);
    const graphId = bytesToHex(p, pos, pos + 13);
    pos += 13;
    const timestampHex = bytesToHex(p, pos, pos + 8);
    pos += 8;
    const n = v.getUint32(pos, true);
    pos += 4;

    const nodes: SparkNode[] = [];
    for (let i = 0; i < n; i++) {
      need(p, pos, 14, `node ${i} of graph ${gi}`);
      const type = p[pos + 12];
      const hasExtra = p[pos + 13];
      let len = 0;
      if (hasExtra !== 0) {
        const known = EXTRA_LEN[type];
        if (known === undefined) {
          throw new KsdError(
            `Unsupported node type ${type} (with extra data) in graph ${gi}. ` +
              `This file contains something the editor has not seen before, so it cannot be edited safely.`,
          );
        }
        len = known;
      }
      need(p, pos, 14 + len, `node ${i} of graph ${gi}`);
      nodes.push({
        id: bytesToHex(p, pos, pos + 4),
        x: v.getFloat32(pos + 4, true),
        y: v.getFloat32(pos + 8, true),
        type,
        hasExtra,
        extra: bytesToHex(p, pos + 14, pos + 14 + len),
      });
      pos += 14 + len;
    }

    need(p, pos, 4, `edge count of graph ${gi}`);
    const m = v.getUint32(pos, true);
    pos += 4;
    need(p, pos, m * 10, `edges of graph ${gi}`);
    const ids = new Set(nodes.map((x) => x.id));
    const edges: SparkEdge[] = [];
    for (let i = 0; i < m; i++) {
      const from = bytesToHex(p, pos, pos + 4);
      const to = bytesToHex(p, pos + 4, pos + 8);
      if (!ids.has(from) || !ids.has(to)) {
        throw new KsdError(`Graph ${gi} has an edge that points at a node that does not exist.`);
      }
      edges.push({ from, to, flag: v.getUint16(pos + 8, true) });
      pos += 10;
    }
    graphs.push({ graphId, timestampHex, nodes, edges });
  }
  return { version, graphs, trailer: p.slice(pos) };
}

export function serializeLogicPayload(logic: LogicData): Uint8Array<ArrayBuffer> {
  let size = 12 + logic.trailer.length;
  for (const g of logic.graphs) {
    size += 13 + 8 + 4 + 4 + g.edges.length * 10;
    for (const n of g.nodes) size += 14 + n.extra.length / 2;
  }
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size - 4, true);
  v.setUint32(4, logic.version, true);
  v.setUint32(8, logic.graphs.length, true);
  let pos = 12;
  for (const g of logic.graphs) {
    out.set(hexToBytes(g.graphId), pos);
    pos += 13;
    out.set(hexToBytes(g.timestampHex), pos);
    pos += 8;
    v.setUint32(pos, g.nodes.length, true);
    pos += 4;
    for (const n of g.nodes) {
      const extra = hexToBytes(n.extra);
      const expected = n.hasExtra !== 0 ? EXTRA_LEN[n.type] : 0;
      if (expected === undefined || extra.length !== expected) {
        throw new KsdError(`Node ${n.id} has inconsistent extra data.`);
      }
      out.set(hexToBytes(n.id), pos);
      v.setFloat32(pos + 4, n.x, true);
      v.setFloat32(pos + 8, n.y, true);
      out[pos + 12] = n.type;
      out[pos + 13] = n.hasExtra;
      out.set(extra, pos + 14);
      pos += 14 + extra.length;
    }
    v.setUint32(pos, g.edges.length, true);
    pos += 4;
    for (const e of g.edges) {
      out.set(hexToBytes(e.from), pos);
      out.set(hexToBytes(e.to), pos + 4);
      v.setUint16(pos + 8, e.flag, true);
      pos += 10;
    }
  }
  out.set(logic.trailer, pos);
  return out;
}

/** True when two logic datasets serialize to exactly the same bytes. */
export function logicEquals(a: LogicData, b: LogicData): boolean {
  return bytesEqual(serializeLogicPayload(a), serializeLogicPayload(b));
}

// ---------------------------------------------------------------- rebuilding the file

/**
 * Produce a new .ksd with the logic chunk replaced by `logic`.
 *
 * Everything outside the logic chunk is copied byte-for-byte. Because the chunk can change
 * length, the file size field, the footer offset, every later chunk's directory offset, and the
 * logic chunk's directory size are updated.
 *
 * The logic chunk's directory checksum is recomputed (XXH3-64, low 32 bits, over the new chunk's
 * bytes). If `logic` serializes to exactly the original payload, the original bytes are returned
 * unchanged.
 */
export function buildKsd(parsed: ParsedKsd, logic: LogicData): Uint8Array<ArrayBuffer> {
  const payload = serializeLogicPayload(logic);
  const orig = parsed.bytes;
  if (bytesEqual(payload, parsed.logicPayload)) {
    const same = new Uint8Array(orig.length);
    same.set(orig);
    return same;
  }

  const e = parsed.logicEntry;
  const oldEnd = e.offset + e.size;
  const newChunkSize = CHUNK_HEADER_SIZE + payload.length;
  const delta = newChunkSize - e.size;

  const out = new Uint8Array(orig.length + delta);
  out.set(orig.subarray(0, e.offset), 0); // everything before, incl. the chunk header's first bytes
  out.set(orig.subarray(e.offset, e.offset + CHUNK_HEADER_SIZE), e.offset); // chunk header (unchanged)
  out.set(payload, e.offset + CHUNK_HEADER_SIZE);
  out.set(orig.subarray(oldEnd), e.offset + newChunkSize);

  const v = new DataView(out.buffer);
  v.setUint32(8, parsed.container.fileSize + delta, true);
  const footer = parsed.container.footerOffset + delta;
  v.setUint32(0x28, footer, true);

  const dirStart = footer + DIR_FOOTER_PAD;
  for (const entry of parsed.entries) {
    const at = dirStart + DIR_ENTRY_SIZE * entry.dirIndex;
    if (entry === e || entry.name === 'logic') {
      v.setUint32(at + 12, newChunkSize, true);
      v.setUint32(at + 16, chunkChecksum(out.subarray(e.offset, e.offset + newChunkSize)), true);
    } else if (entry.offset > e.offset) {
      v.setUint32(at + 8, entry.offset + delta, true);
    }
  }
  return out;
}
