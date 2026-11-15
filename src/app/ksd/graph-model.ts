/**
 * Immutable editing operations on Sparkworks data, the game's connection rules, a change
 * summary, and undo/redo history. Operations return a NEW LogicData (sharing unchanged parts).
 * No Angular dependency.
 */
import type { LogicData, SparkEdge, SparkGraph, SparkNode } from './ksd-core';
import {
  DURATION_FIELDS,
  INSERTABLE_TYPES,
  MAX_CHANNEL,
  MAX_DURATION_MS,
  MAX_NODES_PER_GRAPH,
  MIN_CHANNEL,
  channelExtra,
  channelOf,
  defaultNodeSettings,
  hasChannel,
  slotLabel,
  typeInfo,
  writeDuration,
  type DurationField,
} from './sparkworks-types';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; key: string }
  | null;

export type Result<T> = { ok: true; data: T } | { ok: false; reason: string };
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });

export const edgeKey = (e: SparkEdge): string => `${e.from}>${e.to}#${e.flag}`;

/** Input connection of the target: 0 = upper / only input, 1 = lower (flag's high byte). */
export const slotOf = (flag: number): number => flag >> 8;
export const withSlot = (flag: number, slot: number): number => ((slot & 0xff) << 8) | (flag & 0xff);

function replaceGraph(data: LogicData, gi: number, g: SparkGraph): LogicData {
  const graphs = data.graphs.slice();
  graphs[gi] = g;
  return { ...data, graphs };
}

function replaceNode(data: LogicData, gi: number, nodeId: string, fn: (n: SparkNode) => SparkNode): LogicData | null {
  const g = data.graphs[gi];
  const i = g.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0) return null;
  const nodes = g.nodes.slice();
  nodes[i] = fn(nodes[i]);
  return replaceGraph(data, gi, { ...g, nodes });
}

// ------------------------------------------------------------------ moving

export function moveNode(data: LogicData, gi: number, nodeId: string, x: number, y: number): LogicData {
  const n = data.graphs[gi].nodes.find((q) => q.id === nodeId);
  if (!n || (n.x === x && n.y === y)) return data;
  return replaceNode(data, gi, nodeId, (q) => ({ ...q, x, y })) ?? data;
}

// ------------------------------------------------------------------ connection rules

/** Problems that make a connection impossible regardless of game rules. */
export function structuralIssue(g: SparkGraph, from: string, to: string, flag: number): string | null {
  if (from === to) return 'A node cannot connect to itself.';
  if (!g.nodes.some((n) => n.id === from) || !g.nodes.some((n) => n.id === to)) return 'Both nodes must be in the same graph.';
  if (g.edges.some((e) => e.from === from && e.to === to && e.flag === flag)) return 'That connection already exists.';
  return null;
}

/** The game's rules for what may connect to what. `g` must not already contain the edge itself. */
export function ruleIssue(g: SparkGraph, from: string, to: string, flag: number): string | null {
  const f = g.nodes.find((n) => n.id === from);
  const t = g.nodes.find((n) => n.id === to);
  if (!f || !t) return 'Both nodes must be in the same graph.';
  const fi = typeInfo(f.type);
  const ti = typeInfo(t.type);
  const slot = slotOf(flag);

  if (!fi.outputs) return `${fi.name} has no outputs.`;
  if (ti.inputs === 'none') return `${ti.name} accepts no inputs.`;
  if (slot > 1 || (slot === 1 && ti.inputs !== 'upperLower')) {
    return ti.inputs === 'upperLower' ? 'Invalid input connection.' : `${ti.name} has only one input connection.`;
  }
  if (ti.inputs === 'single' || ti.inputs === 'upperLower') {
    const taken = g.edges.some((e) => e.to === to && slotOf(e.flag) === slot);
    if (taken) {
      return ti.inputs === 'upperLower'
        ? `${ti.name} already has a signal on its ${slotLabel(t.type, slot).toUpperCase()} connection.`
        : `${ti.name} can only accept one input.`;
    }
  }
  if (f.type === 12 && t.type === 11 && channelOf(f) === channelOf(t)) {
    return 'A Use Signal cannot connect to a Save Signal of the same channel.';
  }
  return null;
}

/** Why `from -> to` (in `flag`'s slot) cannot be added, or null if it can. */
export function connectionIssue(g: SparkGraph, from: string, to: string, flag: number, enforceRules = true): string | null {
  return structuralIssue(g, from, to, flag) ?? (enforceRules ? ruleIssue(g, from, to, flag) : null);
}

/** Which input connection a new link into `to` should use when the user has not chosen one. */
export function autoSlot(g: SparkGraph, to: string): number {
  const t = g.nodes.find((n) => n.id === to);
  if (!t || typeInfo(t.type).inputs !== 'upperLower') return 0;
  return g.edges.some((e) => e.to === to && slotOf(e.flag) === 0) ? 1 : 0;
}

export interface RuleProblem {
  /** Edge the problem is about, or null for a node-level problem. */
  key: string | null;
  nodeId: string | null;
  message: string;
}

/** Every rule the graph currently breaks (a clean graph returns an empty list). */
export function validateGraph(g: SparkGraph): RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const e of g.edges) {
    const others: SparkGraph = { ...g, edges: g.edges.filter((x) => x !== e) };
    const why = ruleIssue(others, e.from, e.to, e.flag);
    if (why) problems.push({ key: edgeKey(e), nodeId: null, message: why });
  }
  if (g.nodes.length > MAX_NODES_PER_GRAPH) {
    problems.push({ key: null, nodeId: null, message: `This graph has ${g.nodes.length} nodes; Enshrouded allows at most ${MAX_NODES_PER_GRAPH}.` });
  }
  const saves = new Map<number, string[]>();
  for (const n of g.nodes) {
    if (n.type !== 11) continue;
    const c = channelOf(n);
    if (c !== null) saves.set(c, [...(saves.get(c) ?? []), n.id]);
  }
  for (const [c, ids] of saves) {
    if (ids.length > 1) problems.push({ key: null, nodeId: ids[1], message: `More than one Save Signal uses channel ${c}.` });
  }
  return problems;
}

// ------------------------------------------------------------------ editing links

export function canAddEdge(g: SparkGraph, from: string, to: string, flag: number, enforceRules = true): boolean {
  return connectionIssue(g, from, to, flag, enforceRules) === null;
}

export function addEdge(data: LogicData, gi: number, from: string, to: string, flag: number, enforceRules = true): Result<LogicData> {
  const g = data.graphs[gi];
  const why = connectionIssue(g, from, to, flag, enforceRules);
  if (why) return fail(why);
  return ok(replaceGraph(data, gi, { ...g, edges: [...g.edges, { from, to, flag }] }));
}

export function removeEdge(data: LogicData, gi: number, key: string): LogicData | null {
  const g = data.graphs[gi];
  const i = g.edges.findIndex((e) => edgeKey(e) === key);
  if (i < 0) return null;
  const edges = g.edges.slice();
  edges.splice(i, 1);
  return replaceGraph(data, gi, { ...g, edges });
}

function replaceEdge(data: LogicData, gi: number, key: string, next: SparkEdge, enforceRules: boolean): Result<LogicData> {
  const g = data.graphs[gi];
  const i = g.edges.findIndex((e) => edgeKey(e) === key);
  if (i < 0) return fail('That link no longer exists.');
  const without: SparkGraph = { ...g, edges: g.edges.filter((_, j) => j !== i) };
  const why = connectionIssue(without, next.from, next.to, next.flag, enforceRules);
  if (why) return fail(why);
  const edges = g.edges.slice();
  edges[i] = next;
  return ok(replaceGraph(data, gi, { ...g, edges }));
}

/** Swap source and target. The slot is kept when the new target has two inputs, otherwise reset to 0. */
export function reverseEdge(data: LogicData, gi: number, key: string, enforceRules = true): Result<LogicData> {
  const g = data.graphs[gi];
  const e = g.edges.find((x) => edgeKey(x) === key);
  if (!e) return fail('That link no longer exists.');
  const newTarget = g.nodes.find((n) => n.id === e.from);
  const keepSlot = !!newTarget && typeInfo(newTarget.type).inputs === 'upperLower';
  return replaceEdge(data, gi, key, { from: e.to, to: e.from, flag: withSlot(e.flag, keepSlot ? slotOf(e.flag) : 0) }, enforceRules);
}

export function setEdgeSlot(data: LogicData, gi: number, key: string, slot: number, enforceRules = true): Result<LogicData> {
  const e = data.graphs[gi].edges.find((x) => edgeKey(x) === key);
  if (!e) return fail('That link no longer exists.');
  return replaceEdge(data, gi, key, { ...e, flag: withSlot(e.flag, slot) }, enforceRules);
}

// ------------------------------------------------------------------ editing node settings

/** Change a Save/Use Signal's channel (1-32). */
export function setChannel(data: LogicData, gi: number, nodeId: string, channel: number, enforceRules = true): Result<LogicData> {
  const g = data.graphs[gi];
  const n = g.nodes.find((q) => q.id === nodeId);
  if (!n || !hasChannel(n.type)) return fail('This node has no channel.');
  if (!Number.isInteger(channel) || channel < MIN_CHANNEL || channel > MAX_CHANNEL) {
    return fail(`Channel must be a whole number from ${MIN_CHANNEL} to ${MAX_CHANNEL}.`);
  }
  if (channelOf(n) === channel) return ok(data);
  if (enforceRules) {
    if (n.type === 11 && g.nodes.some((q) => q.type === 11 && q.id !== n.id && channelOf(q) === channel)) {
      return fail(`Another Save Signal in this graph already uses channel ${channel}.`);
    }
    const typeOf = new Map(g.nodes.map((q) => [q.id, q]));
    for (const e of g.edges) {
      const a = typeOf.get(e.from);
      const b = typeOf.get(e.to);
      if (!a || !b || a.type !== 12 || b.type !== 11) continue;
      const ca = a.id === n.id ? channel : channelOf(a);
      const cb = b.id === n.id ? channel : channelOf(b);
      if (ca === cb) return fail('That would connect a Use Signal to a Save Signal of the same channel.');
    }
  }
  const next = replaceNode(data, gi, nodeId, (q) => ({ ...q, extra: channelExtra(channel) }));
  return next ? ok(next) : fail('Node not found.');
}

/** Change a Hold / Clock / Timed Trigger time value (milliseconds, 0 to 10:00.000). */
export function setDuration(data: LogicData, gi: number, nodeId: string, field: DurationField, ms: number): Result<LogicData> {
  const n = data.graphs[gi].nodes.find((q) => q.id === nodeId);
  if (!n || !DURATION_FIELDS[n.type]?.includes(field)) return fail('This node has no such setting.');
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_DURATION_MS) return fail('Time must be between 0:0:000 and 10:0:000.');
  const extra = writeDuration(n, field, ms);
  if (extra === null) return fail('This node has no such setting.');
  if (extra === n.extra) return ok(data);
  const next = replaceNode(data, gi, nodeId, (q) => ({ ...q, extra }));
  return next ? ok(next) : fail('Node not found.');
}

// ------------------------------------------------------------------ inserting / deleting nodes

/** Pick a random 4-byte node id (hex) that no node anywhere in the file already uses. */
export function newNodeId(data: LogicData, rand: () => number = Math.random): string {
  const used = new Set<string>();
  for (const g of data.graphs) for (const n of g.nodes) used.add(n.id);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = '';
    for (let i = 0; i < 4; i++) id += Math.floor(rand() * 256).toString(16).padStart(2, '0');
    if (!used.has(id)) return id;
  }
  throw new Error('Could not find an unused node id.');
}

export interface InsertSpec {
  type: number;
  x: number;
  y: number;
}
export interface Inserted {
  data: LogicData;
  id: string;
}

function lowestFreeSaveChannel(g: SparkGraph): number | null {
  const used = new Set(g.nodes.filter((n) => n.type === 11).map((n) => channelOf(n)));
  for (let c = MIN_CHANNEL; c <= MAX_CHANNEL; c++) if (!used.has(c)) return c;
  return null;
}

function nodeLimitIssue(g: SparkGraph): string | null {
  return g.nodes.length >= MAX_NODES_PER_GRAPH
    ? `This graph already has ${MAX_NODES_PER_GRAPH} nodes, the most Enshrouded allows.`
    : null;
}

/**
 * Add a new node of `spec.type` at (x, y), appended at the end of the node list (as the game
 * does). The 200-node limit always applies. A new Save Signal gets the lowest free channel (when
 * rules are enforced, all 32 in use is an error); a new Use Signal starts on the lowest channel
 * that has a Save Signal. A new World Object has no object assigned.
 */
export function insertNode(data: LogicData, gi: number, spec: InsertSpec, enforceRules = true, rand?: () => number): Result<Inserted> {
  const g = data.graphs[gi];
  if (!INSERTABLE_TYPES.includes(spec.type)) return fail(`Unknown node type ${spec.type}.`);
  const limit = nodeLimitIssue(g);
  if (limit) return fail(limit);

  let channel = 1;
  if (spec.type === 11) {
    const free = lowestFreeSaveChannel(g);
    if (free !== null) channel = free;
    else if (enforceRules) return fail('All 32 Save Signal channels are already in use in this graph.');
  } else if (spec.type === 12) {
    const saves = g.nodes.filter((n) => n.type === 11).map((n) => channelOf(n) ?? MAX_CHANNEL + 1);
    channel = saves.length ? Math.min(...saves) : 1;
  }
  const id = newNodeId(data, rand);
  const { hasExtra, extra } = defaultNodeSettings(spec.type, channel);
  const node: SparkNode = { id, x: spec.x, y: spec.y, type: spec.type, hasExtra, extra };
  return ok({ data: replaceGraph(data, gi, { ...g, nodes: [...g.nodes, node] }), id });
}

/**
 * Copy a node (type and settings, not its links) to a position offset from the original. A copy of
 * a World Object is a new World Object with no object assigned, since one object is never
 * referenced twice in a graph.
 */
export function duplicateNode(data: LogicData, gi: number, nodeId: string, enforceRules = true, rand?: () => number, offset = 60): Result<Inserted> {
  const g = data.graphs[gi];
  const src = g.nodes.find((n) => n.id === nodeId);
  if (!src) return fail('Node not found.');
  const limit = nodeLimitIssue(g);
  if (limit) return fail(limit);

  let extra = src.extra;
  let hasExtra = src.hasExtra;
  if (src.type === 0) {
    extra = '';
    hasExtra = 0;
  }
  if (src.type === 11) {
    const free = lowestFreeSaveChannel(g);
    if (free !== null) extra = channelExtra(free);
    else if (enforceRules) return fail('All 32 Save Signal channels are already in use in this graph.');
  }
  const id = newNodeId(data, rand);
  const node: SparkNode = { ...src, id, x: src.x + offset, y: src.y + offset, hasExtra, extra };
  return ok({ data: replaceGraph(data, gi, { ...g, nodes: [...g.nodes, node] }), id });
}

export interface Deleted {
  data: LogicData;
  /** Links that were removed along with the node. */
  removedEdges: number;
  /** Use Signals left on a channel that no longer has a Save Signal (when a Save Signal was deleted). */
  orphanedUses: number;
}

/**
 * Remove a node and every link that touches it. Like the game, the last node in the list takes
 * the deleted node's place (so only that one node changes position in the list), which was
 * confirmed byte for byte against a game-written save.
 */
export function deleteNode(data: LogicData, gi: number, nodeId: string): Deleted | null {
  const g = data.graphs[gi];
  const idx = g.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return null;
  const node = g.nodes[idx];
  const edges = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  const nodes = g.nodes.slice();
  const last = nodes.pop()!;
  if (idx < nodes.length) nodes[idx] = last;
  let orphanedUses = 0;
  if (node.type === 11) {
    const c = channelOf(node);
    const stillSaved = nodes.some((n) => n.type === 11 && channelOf(n) === c);
    if (!stillSaved) orphanedUses = nodes.filter((n) => n.type === 12 && channelOf(n) === c).length;
  }
  return { data: replaceGraph(data, gi, { ...g, nodes, edges }), removedEdges: g.edges.length - edges.length, orphanedUses };
}

// ------------------------------------------------------------------ change summary

export interface GraphChanges {
  addedNodes: number;
  removedNodes: number;
  movedNodes: number;
  /** Nodes whose settings (channel / times) changed. */
  editedNodes: number;
  addedEdges: number;
  removedEdges: number;
}
export interface ChangeSummary extends GraphChanges {
  perGraph: GraphChanges[];
  total: number;
}

export function summarizeChanges(original: LogicData, current: LogicData): ChangeSummary {
  const perGraph: GraphChanges[] = current.graphs.map((g, gi) => {
    const o = original.graphs[gi];
    if (o === g) return { addedNodes: 0, removedNodes: 0, movedNodes: 0, editedNodes: 0, addedEdges: 0, removedEdges: 0 };
    const before = new Map(o.nodes.map((n) => [n.id, n]));
    const now = new Set(g.nodes.map((n) => n.id));
    let addedNodes = 0;
    let movedNodes = 0;
    let editedNodes = 0;
    for (const n of g.nodes) {
      const on = before.get(n.id);
      if (!on) {
        addedNodes++;
        continue;
      }
      if (Math.fround(on.x) !== Math.fround(n.x) || Math.fround(on.y) !== Math.fround(n.y)) movedNodes++;
      if (on.extra !== n.extra) editedNodes++;
    }
    const counts = new Map<string, number>();
    for (const e of o.edges) counts.set(edgeKey(e), (counts.get(edgeKey(e)) ?? 0) + 1);
    let addedEdges = 0;
    for (const e of g.edges) {
      const k = edgeKey(e);
      const c = counts.get(k) ?? 0;
      if (c > 0) counts.set(k, c - 1);
      else addedEdges++;
    }
    let removedEdges = 0;
    for (const c of counts.values()) removedEdges += c;
    let removedNodes = 0;
    for (const id of before.keys()) if (!now.has(id)) removedNodes++;
    return { addedNodes, removedNodes, movedNodes, editedNodes, addedEdges, removedEdges };
  });
  const sum = (f: (c: GraphChanges) => number) => perGraph.reduce((a, c) => a + f(c), 0);
  const addedNodes = sum((c) => c.addedNodes);
  const removedNodes = sum((c) => c.removedNodes);
  const movedNodes = sum((c) => c.movedNodes);
  const editedNodes = sum((c) => c.editedNodes);
  const addedEdges = sum((c) => c.addedEdges);
  const removedEdges = sum((c) => c.removedEdges);
  return {
    perGraph,
    addedNodes,
    removedNodes,
    movedNodes,
    editedNodes,
    addedEdges,
    removedEdges,
    total: addedNodes + removedNodes + movedNodes + editedNodes + addedEdges + removedEdges,
  };
}

// ------------------------------------------------------------------ undo / redo

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(
    private present: T,
    private readonly limit = 200,
  ) {}

  get current(): T {
    return this.present;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Record a new state. Ignored when it is the same object as the current one. */
  push(next: T): void {
    if (next === this.present) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }
  undo(): T {
    const prev = this.past.pop();
    if (prev !== undefined) {
      this.future.push(this.present);
      this.present = prev;
    }
    return this.present;
  }
  redo(): T {
    const next = this.future.pop();
    if (next !== undefined) {
      this.past.push(this.present);
      this.present = next;
    }
    return this.present;
  }
}
