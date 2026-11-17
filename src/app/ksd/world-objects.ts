/**
 * Read-only lookup of what a World Object node is linked to.
 *
 * A World Object node's 4-byte extra is an entity id in the zstd-compressed `entity_chunk00` chunk.
 * Around that id the entity record holds (reverse-engineered, see CLAUDE.md section 4.5a):
 *
 *   [4-byte object-type id][4-byte entity id][1 byte ?][8-byte custom_strings key = player-given name]
 *
 * Nothing here is ever written back: `entity_chunk00` is only decompressed to read names.
 */
import { decompress } from 'fzstd';
import { CHUNK_HEADER_SIZE, bytesToHex, type ParsedKsd } from './ksd-core';

/** Object types identified in the game. Keys are the 4 type-id bytes as hex, in file order. */
export const KNOWN_OBJECT_TYPES: Readonly<Record<string, string>> = {
  a2455b47: 'Switch Button', // user-confirmed in game
  '766656b9': 'Door', // user-confirmed in game
  '71b5fbd5': 'Pressure Plate', // user-confirmed in game
  ea26760e: 'Torch', // user-confirmed in game (a kind of light)
  a6dc827c: 'Spawner', // user-confirmed in game
  d4c57f10: 'Light', // inferred: every named object of this type is a light
};

export const SPAWNER_TYPE = 'a6dc827c';

/** Enemy ids stored in Spawner records (4 bytes as hex, file order), user-confirmed in game. */
export const KNOWN_ENEMIES: Readonly<Record<string, string>> = {
  '1d2a1178': 'Fell Defender I',
  b862338b: 'Fell Soldier II',
  '5e56f58b': 'Fell Crusader',
  '71153792': 'Fell Commander',
  a76ce83e: 'Fell Scout II',
  '050ffb09': 'Fell Marksman',
};

/** A Spawner's settings, read from its entity record (verified against six spawners set in game). */
export interface SpawnerSettings {
  enemyId: string;
  enemyName: string | null;
  /** Level relative to the player, -5 to +5. */
  levelOffset: number;
  /** Wait before spawning again after the enemy is killed, in milliseconds. */
  timeoutMs: number;
}

/** Spawner fields, as offsets from the entity id. */
const SPAWNER_ENEMY = 13;
const SPAWNER_LEVEL = 17; // i8
const SPAWNER_TIMEOUT = 18; // u64 nanoseconds
const SPAWNER_END = SPAWNER_TIMEOUT + 8;

function readSpawner(ent: Uint8Array, at: number): SpawnerSettings | null {
  if (at + SPAWNER_END > ent.length) return null;
  const v = new DataView(ent.buffer, ent.byteOffset, ent.byteLength);
  const enemyId = bytesToHex(ent.subarray(at + SPAWNER_ENEMY, at + SPAWNER_ENEMY + 4));
  const levelOffset = v.getInt8(at + SPAWNER_LEVEL);
  const ns = v.getBigUint64(at + SPAWNER_TIMEOUT, true);
  // refuse anything outside what the game allows, rather than show a wrong value
  if (levelOffset < -5 || levelOffset > 5 || ns > 600_000_000_000n || ns % 1_000_000n !== 0n) return null;
  return { enemyId, enemyName: KNOWN_ENEMIES[enemyId] ?? null, levelOffset, timeoutMs: Number(ns / 1_000_000n) };
}

/** Object types that only output a signal and accept no input links (user-confirmed in game). */
export const OUTPUT_ONLY_OBJECT_TYPES: ReadonlySet<string> = new Set(['71b5fbd5' /* Pressure Plate */]);

export interface WorldObjectInfo {
  /** Whether the entity was found in this save. */
  found: boolean;
  /** Object-type id (hex), when found. */
  typeId: string | null;
  /** Readable type name, when the type id is a known one. */
  typeName: string | null;
  /** The name the player gave the object in the game, if any. */
  name: string | null;
  /** Settings of a Spawner (null for other objects, or if the record could not be read). */
  spawner: SpawnerSettings | null;
}

export interface WorldObjectIndex {
  /** False when entity_chunk00 is missing or could not be read; then nothing is resolved. */
  available: boolean;
  /** Look up a World Object ref (the node's extra, hex). */
  lookup(ref: string): WorldObjectInfo;
}

const TYPE_LEN = 4;
const ID_LEN = 4;
const NAME_OFFSET = ID_LEN + 1;
const NAME_KEY_LEN = 8;

const NOT_FOUND: WorldObjectInfo = { found: false, typeId: null, typeName: null, name: null, spawner: null };

/** The decompressed body of a chunk, or null if it is missing, unreadable or not zstd-compressed. */
export function readZstdChunk(parsed: Pick<ParsedKsd, 'bytes' | 'entries'>, name: string): Uint8Array | null {
  const e = parsed.entries.find((x) => x.name === name);
  if (!e || e.size <= CHUNK_HEADER_SIZE) return null;
  const raw = parsed.bytes.subarray(e.offset, e.offset + e.size);
  const type = raw[8] | (raw[9] << 8);
  if (((type >> 8) & 1) === 0) return null;
  try {
    return decompress(raw.subarray(CHUNK_HEADER_SIZE));
  } catch {
    return null;
  }
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  const last = hay.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

/** Build a lookup for World Object refs from a parsed save. Results are cached per ref. */
export function indexWorldObjects(parsed: Pick<ParsedKsd, 'bytes' | 'entries' | 'customStrings'>): WorldObjectIndex {
  const ent = readZstdChunk(parsed, 'entity_chunk00');
  const cache = new Map<string, WorldObjectInfo>();
  return {
    available: ent !== null,
    lookup(ref: string): WorldObjectInfo {
      if (!ent || !/^[0-9a-f]{8}$/i.test(ref)) return NOT_FOUND;
      const key = ref.toLowerCase();
      const hit = cache.get(key);
      if (hit) return hit;
      const needle = new Uint8Array(ID_LEN);
      for (let i = 0; i < ID_LEN; i++) needle[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
      const at = indexOf(ent, needle);
      let info = NOT_FOUND;
      if (at >= TYPE_LEN) {
        const typeId = bytesToHex(ent.subarray(at - TYPE_LEN, at));
        const nameAt = at + NAME_OFFSET;
        const name =
          nameAt + NAME_KEY_LEN <= ent.length
            ? (parsed.customStrings.get(bytesToHex(ent.subarray(nameAt, nameAt + NAME_KEY_LEN))) ?? null)
            : null;
        const spawner = typeId === SPAWNER_TYPE ? readSpawner(ent, at) : null;
        info = { found: true, typeId, typeName: KNOWN_OBJECT_TYPES[typeId] ?? null, name, spawner };
      }
      cache.set(key, info);
      return info;
    },
  };
}

/**
 * For the graph rules: given a World Object ref, the object's type name when that object accepts
 * no inputs (for example a Pressure Plate), otherwise null.
 */
export function outputOnlyObject(idx: WorldObjectIndex | null, ref: string): string | null {
  if (!idx?.available || !ref) return null;
  const o = idx.lookup(ref);
  return o.found && o.typeId && OUTPUT_ONLY_OBJECT_TYPES.has(o.typeId) ? (o.typeName ?? 'This object') : null;
}

/** Short text for a World Object node: its name, else its type, else a status. */
export function worldObjectLabel(ref: string, info: WorldObjectInfo | null): string {
  if (!ref) return 'no object';
  if (!info) return `ref ${ref}`;
  if (!info.found) return 'not in this save';
  if (info.name) return info.name;
  return info.typeName ? `unnamed ${info.typeName}` : `type ${info.typeId}`;
}
