/**
 * What is known about Sparkworks node types. Names, categories, colours and connection rules
 * come from the game (supplied by the user); how settings are stored in the file was worked out
 * from game-written save files. No Angular dependency.
 */
import { bytesToHex, hexToBytes, type SparkNode } from './ksd-core';

export type Category = 'world' | 'time' | 'logic' | 'state';

/**
 * How many signals a node accepts:
 *  - none:       accepts no inputs
 *  - many:       any number of inputs
 *  - single:     exactly one input connection
 *  - upperLower: one input on its UPPER connection and one on its LOWER connection
 */
export type InputKind = 'none' | 'many' | 'single' | 'upperLower';

export interface NodeTypeInfo {
  type: number;
  name: string;
  /** Short label drawn inside the node. */
  short: string;
  category: Category;
  description: string;
  inputs: InputKind;
  /** Whether the node can feed other nodes. */
  outputs: boolean;
}

const T = (
  type: number,
  name: string,
  short: string,
  category: Category,
  inputs: InputKind,
  outputs: boolean,
  description: string,
): NodeTypeInfo => ({ type, name, short, category, inputs, outputs, description });

export const NODE_TYPES: Readonly<Record<number, NodeTypeInfo>> = {
  0: T(0, 'World Object', 'OBJ', 'world', 'many', true, 'An object in the world, such as a door, a light or a trigger zone.'),
  1: T(1, 'Hold', 'HOLD', 'time', 'single', true, 'Turns ON when an ON signal arrives and stays on for the set delay, even after the input turns OFF.'),
  2: T(2, 'Clock', 'CLK', 'time', 'single', true, 'Switches between ON and OFF automatically; the interval sets the time between switches.'),
  3: T(3, 'AND', 'AND', 'logic', 'many', true, 'ON only if all incoming signals are ON.'),
  4: T(4, 'OR', 'OR', 'logic', 'many', true, 'ON if at least one incoming signal is ON.'),
  5: T(5, 'NOT', 'NOT', 'logic', 'single', true, 'Flips the incoming signal: ON becomes OFF and OFF becomes ON.'),
  6: T(6, 'NAND', 'NAND', 'logic', 'many', true, 'Transmits OFF if all incoming signals are ON, otherwise ON.'),
  7: T(7, 'XOR', 'XOR', 'logic', 'many', true, 'ON if exactly one incoming signal is ON; OFF if more than one is ON.'),
  8: T(8, 'D Flip-Flop', 'DFF', 'state', 'upperLower', true, 'LOWER ON: samples and stores the UPPER signal. LOWER OFF: holds its state and ignores UPPER.'),
  9: T(9, 'Toggle', 'TGL', 'state', 'upperLower', true, 'Signals on UPPER toggle the node between ON and OFF. A signal on LOWER resets it to OFF.'),
  10: T(10, 'Timed Trigger', 'TT', 'time', 'upperLower', true, 'When UPPER goes OFF to ON it stays OFF for the delay, then turns ON for the interval. An ON on LOWER resets it.'),
  11: T(11, 'Save Signal', 'S', 'state', 'single', false, 'Saves its input on a channel (1-32). Only one Save Signal per channel per graph. Has no outputs.'),
  12: T(12, 'Use Signal', 'U', 'state', 'none', true, 'Outputs the signal saved by the Save Signal of the same channel (1-32). Accepts no inputs.'),
  13: T(13, 'On', 'ON', 'logic', 'none', true, 'Always ON. Accepts no inputs.'),
  14: T(14, 'Off', 'OFF', 'logic', 'none', true, 'Always OFF. Accepts no inputs.'),
  15: T(15, 'Flank', 'FLK', 'state', 'single', true, 'Turns ON briefly when it receives an ON signal, then turns OFF.'),
  16: T(16, 'Global Reset', 'RST', 'state', 'single', false, 'Resets all Sparkworks graphs. Has no outputs.'),
};

export const CATEGORY_COLORS: Readonly<Record<Category, string>> = {
  world: '#9aa0a6', // gray
  time: '#f08bb4', // pink
  logic: '#5b9cf0', // blue
  state: '#a98bf0', // purple
};

export const CATEGORY_NAMES: Readonly<Record<Category, string>> = {
  world: 'World Object',
  time: 'Time Node',
  logic: 'Logic Operator',
  state: 'Saving State',
};

export function typeInfo(type: number): NodeTypeInfo {
  return (
    NODE_TYPES[type] ??
    T(type, `Unknown type ${type}`, `T${type}`, 'world', 'many', true, 'A node type this editor does not know.')
  );
}
export const typeName = (type: number): string => typeInfo(type).name;
export const typeColor = (type: number): string => CATEGORY_COLORS[typeInfo(type).category];

/** Name of an input connection ("Upper" / "Lower" on two-input nodes, otherwise "Input"). */
export function slotLabel(type: number, slot: number): string {
  if (typeInfo(type).inputs !== 'upperLower') return 'Input';
  return slot === 0 ? 'Upper' : slot === 1 ? 'Lower' : `Slot ${slot}`;
}

// --------------------------------------------------------------------------- channels

export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 32;
export const hasChannel = (type: number): boolean => type === 11 || type === 12;

/** Channel (1-32) of a Save/Use Signal node. Stored as one byte holding channel - 1. */
export function channelOf(node: SparkNode): number | null {
  if (!hasChannel(node.type) || node.extra.length !== 2) return null;
  return parseInt(node.extra, 16) + 1;
}
export function channelExtra(channel: number): string {
  return (channel - 1).toString(16).padStart(2, '0');
}

// --------------------------------------------------------------------------- durations

export type DurationField = 'delay' | 'interval';
export const MAX_DURATION_MS = 600_000; // 10:0:000

/**
 * Which stored time values a node has. Each is a u64 count of nanoseconds. Timed Trigger stores
 * the delay first and the interval second (confirmed by the defaults the game writes: delay 1 s, interval 0).
 */
export const DURATION_FIELDS: Readonly<Record<number, readonly DurationField[]>> = {
  1: ['delay'],
  2: ['interval'],
  10: ['delay', 'interval'],
};
export const DURATION_LABELS: Readonly<Record<DurationField, string>> = { delay: 'Delay', interval: 'Interval' };

export interface DurationValue {
  field: DurationField;
  label: string;
  ms: number;
  text: string;
}

export function readDurations(node: SparkNode): DurationValue[] {
  const fields = DURATION_FIELDS[node.type];
  if (!fields || node.extra.length !== fields.length * 16) return [];
  const view = new DataView(hexToBytes(node.extra).buffer);
  return fields.map((field, i) => {
    const ms = Number(view.getBigUint64(i * 8, true) / 1_000_000n);
    return { field, label: DURATION_LABELS[field], ms, text: formatDuration(ms) };
  });
}

/** New extra-data hex for `node` with one duration replaced. Returns null if the node lacks it. */
export function writeDuration(node: SparkNode, field: DurationField, ms: number): string | null {
  const fields = DURATION_FIELDS[node.type];
  const idx = fields ? fields.indexOf(field) : -1;
  if (!fields || idx < 0 || node.extra.length !== fields.length * 16) return null;
  const bytes = hexToBytes(node.extra);
  new DataView(bytes.buffer).setBigUint64(idx * 8, BigInt(ms) * 1_000_000n, true);
  return bytesToHex(bytes);
}

/** minutes:seconds:milliseconds, e.g. 0:5:000 or 10:0:000. */
export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${s}:${String(ms % 1000).padStart(3, '0')}`;
}

/** Parse "m:s:ms" or plain seconds ("1.5"). Returns whole milliseconds, or null if invalid. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':');
  const num = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : NaN);
  let ms: number;
  if (parts.length === 3) {
    ms = num(parts[0]) * 60_000 + num(parts[1]) * 1000 + num(parts[2]);
  } else if (parts.length === 1 && /^\d+(\.\d{1,3})?$/.test(t)) {
    ms = Math.round(Number(t) * 1000);
  } else {
    return null;
  }
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

// --------------------------------------------------------------------------- creating nodes

/** Enshrouded's limit on nodes in one Sparkworks graph. */
export const MAX_NODES_PER_GRAPH = 200;

/**
 * Types that can be inserted: all of them. A new World Object has no object assigned (the game
 * itself writes such a node with no extra data); it is linked to a real object inside the game.
 */
export const INSERTABLE_TYPES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/**
 * Starting times for new time nodes. These are the values the game itself gives a freshly
 * created node (read from a game-written save): Hold delay 0.5 s, Clock interval 0.5 s,
 * Timed Trigger delay 1 s and interval 0.
 */
const DEFAULT_DURATION_MS: Readonly<Record<number, Partial<Record<DurationField, number>>>> = {
  1: { delay: 500 },
  2: { interval: 500 },
  10: { delay: 1000, interval: 0 },
};

/**
 * The hasExtra byte and extra data for a freshly created node of `type`, matching what the game
 * writes: times for Hold / Clock / Timed Trigger, a channel byte for Save / Use Signal, and no
 * extra data for everything else, including a World Object with no object assigned.
 */
export function defaultNodeSettings(type: number, channel = 1): { hasExtra: number; extra: string } {
  const fields = DURATION_FIELDS[type];
  if (fields) {
    let node: SparkNode = { id: '', x: 0, y: 0, type, hasExtra: 1, extra: '00'.repeat(fields.length * 8) };
    for (const f of fields) {
      const extra = writeDuration(node, f, DEFAULT_DURATION_MS[type]?.[f] ?? 0);
      if (extra !== null) node = { ...node, extra };
    }
    return { hasExtra: 1, extra: node.extra };
  }
  if (hasChannel(type)) return { hasExtra: 1, extra: channelExtra(channel) };
  return { hasExtra: 0, extra: '' };
}

// --------------------------------------------------------------------------- short labels

/** Compact time for a node's second line: 500 -> "0.5s", 60000 -> "1m", 65250 -> "1m5.25s". */
export function compactDuration(ms: number): string {
  const trimmed = (n: number) => String(Number(n.toFixed(3)));
  if (ms < 60_000) return `${trimmed(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const rest = ms - m * 60_000;
  return rest === 0 ? `${m}m` : `${m}m${trimmed(rest / 1000)}s`;
}

/** Second line shown on a node box (channel, times, object), or '' when there is nothing to add. */
export function nodeSubtitle(node: SparkNode): string {
  const ch = channelOf(node);
  if (ch !== null) return `Channel ${ch}`;
  const d = readDurations(node);
  if (node.type === 1 && d[0]) return `Delay ${compactDuration(d[0].ms)}`;
  if (node.type === 2 && d[0]) return `Interval ${compactDuration(d[0].ms)}`;
  if (node.type === 10 && d.length === 2) return `D ${compactDuration(d[0].ms)} \u00b7 I ${compactDuration(d[1].ms)}`;
  if (node.type === 0) return node.extra ? `ref ${node.extra}` : 'no object';
  return '';
}
