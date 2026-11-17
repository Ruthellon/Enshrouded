/**
 * Step-by-step simulation of one Sparkworks graph, for the editor's Test mode.
 *
 * Time advances in fixed ticks. Within a tick, signals settle through the whole graph first (as in the
 * game: a signal reaches every node in the same moment), and only then do timers, toggles and
 * flip-flops update from the settled inputs. Without this, a node reached by two paths of different
 * length would see a stale value on one input (e.g. a Timed Trigger whose LOWER is a NOT of its
 * UPPER source would never start).
 *
 * Settling evaluates nodes in link order with the newest values, so a node only ever sees its inputs'
 * final values (no glitch where a fast and a slow path meet). So the signal can still be followed, each
 * tick also records `waves`: the final changes revealed by link depth. The UI plays these before moving on.
 *
 * Node behaviour follows the game's own descriptions (see NODE_TYPES). Where a description leaves
 * something open, the choice made here is marked ASSUMPTION; correct these when the game is seen to
 * behave differently. Nothing here touches the save.
 */
import type { SparkGraph, SparkNode } from './ksd-core';
import { slotOf } from './graph-model';
import { channelOf, readDurations, typeInfo } from './sparkworks-types';

/** How a World Object's output is driven during a test. */
export type ObjectMode = 'auto' | 'on' | 'off';

export interface SimEvent {
  /** Simulated time in ms. */
  t: number;
  nodeId: string;
  on: boolean;
  /** What caused it, when it was the user (e.g. "pushed"). */
  cause?: string;
}

export interface SimOptions {
  /** Simulated milliseconds per tick. */
  tickMs?: number;
  /** How long a pushed button stays ON. */
  pulseMs?: number;
  /**
   * World Objects that are enemy Spawners (node id -> Spawn Timeout in ms). While ON a spawner keeps an
   * enemy alive and outputs ON; when the enemy is defeated (`defeat`) it outputs OFF until the next
   * enemy spawns, `timeout` later.
   */
  spawners?: ReadonlyMap<string, number>;
}

export const DEFAULT_TICK_MS = 50;
/** ASSUMPTION: a pushed button sends ON for half a second. */
export const DEFAULT_PULSE_MS = 500;
const MAX_LOG = 300;

interface NodeState {
  /** Settled input value per slot in the previous tick (for detecting OFF -> ON). */
  lastIn: [boolean, boolean];
  /** Toggle / D Flip-Flop memory. */
  mem: boolean;
  /** Hold: when the input last went ON. Clock: when it started. Timed Trigger: when it was started. */
  since: number | null;
  /** World Object: forced output, and ON-until time of a push. */
  mode: ObjectMode;
  pulseUntil: number;
  /** Spawner: when the next enemy appears after the last one was defeated (null = an enemy is there). */
  respawnAt: number | null;
}

/** A node's output for one evaluation, and the state it would keep if this is the settled result. */
interface Eval {
  on: boolean;
  mem?: boolean;
  since?: number | null;
  respawnAt?: number | null;
}

type Get = (id: string) => boolean;

export class GraphSim {
  readonly tickMs: number;
  readonly pulseMs: number;
  private readonly nodes: readonly SparkNode[];
  private readonly byId: ReadonlyMap<string, SparkNode>;
  /** Sources feeding each node, per input slot. */
  private readonly sources = new Map<string, [string[], string[]]>();
  private readonly durations = new Map<string, number[]>();
  /** Save Signal node ids per channel. */
  private readonly saves = new Map<number, string[]>();
  /**
   * Value stored on each channel as of the end of the previous tick; Use Signals read this.
   * INFERRED: a Use Signal sees its Save Signal one tick later. With same-tick passing, one pulse ran
   * through a whole chain of Save/Use latches at once (the life counter in "Encounter 1 v2": six
   * zero-length Timed Triggers -> OR -> latches on ch2, ch3, ch4 took every life with one pulse).
   */
  private stored = new Map<number, boolean>();
  private readonly spawners: ReadonlyMap<string, number>;
  private state = new Map<string, NodeState>();
  private out = new Map<string, boolean>();
  private _time = 0;
  private _changed = new Set<string>();
  private _waves: ReadonlySet<string>[] = [];
  private _log: SimEvent[] = [];
  /**
   * D Flip-Flop memory while a tick settles. A D Flip-Flop is transparent while LOWER is ON, so its
   * stored value must follow UPPER *within* the tick; when LOWER then drops in the same tick (e.g. its
   * own output turns LOWER off through a NOT) it keeps the value it just passed, not the one from
   * before the tick. Null outside settling (committed memory is used then).
   */
  private work: Map<string, boolean> | null = null;
  /**
   * Toggle memory and last-seen inputs while a tick settles. A Toggle reacts to *changes*, so within
   * settling it must compare with the inputs it saw in the previous round, not with the previous
   * tick; otherwise one UPPER change is counted again in every round, and a Toggle in a loop (Toggle ->
   * Spawner -> Save/Use -> NOT -> its own LOWER) flips back ON after its reset. Null outside settling.
   */
  private toggleWork: Map<string, { mem: boolean; seen: [boolean, boolean] }> | null = null;
  /**
   * Nodes in link order (every node after the nodes feeding it; nodes in loops at the end, in their
   * original order). Settling evaluates in this order with the newest values, so a node sees its
   * inputs' final values and no short-lived glitch appears where paths of different length meet.
   */
  private readonly order: readonly SparkNode[];

  constructor(graph: SparkGraph, opts: SimOptions = {}) {
    this.tickMs = Math.max(1, opts.tickMs ?? DEFAULT_TICK_MS);
    this.pulseMs = Math.max(this.tickMs, opts.pulseMs ?? DEFAULT_PULSE_MS);
    this.nodes = graph.nodes;
    this.spawners = opts.spawners ?? new Map();
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const n of graph.nodes) {
      this.sources.set(n.id, [[], []]);
      this.durations.set(n.id, readDurations(n).map((d) => d.ms));
      const c = n.type === 11 ? channelOf(n) : null;
      if (c !== null) this.saves.set(c, [...(this.saves.get(c) ?? []), n.id]);
    }
    for (const e of graph.edges) {
      const s = this.sources.get(e.to);
      if (s && this.byId.has(e.from)) s[Math.min(1, slotOf(e.flag))].push(e.from);
    }
    this.order = linkOrder(graph.nodes, this.sources);
    this.reset();
  }

  // ------------------------------------------------------------------ reading

  get time(): number {
    return this._time;
  }
  /** Current output of a node. */
  isOn(id: string): boolean {
    return this.out.get(id) ?? false;
  }
  /** Ids of nodes whose output is ON. */
  onNodes(): ReadonlySet<string> {
    return onSet(this.out);
  }
  /** Nodes whose output changed in the last tick. */
  changed(): ReadonlySet<string> {
    return this._changed;
  }
  /**
   * How the last tick's changes spread: the ON-set after each round of settling (the last one equals
   * `onNodes()`). Empty when nothing changed.
   */
  waves(): readonly ReadonlySet<string>[] {
    return this._waves;
  }
  /** Newest last. */
  log(): readonly SimEvent[] {
    return this._log;
  }
  objectMode(id: string): ObjectMode {
    return this.state.get(id)?.mode ?? 'auto';
  }
  /** Value of each input slot as of the current tick. */
  inputs(id: string): [boolean, boolean] {
    return [this.slotIn(id, 0, (x) => this.isOn(x)), this.slotIn(id, 1, (x) => this.isOn(x))];
  }
  /** Internal memory of Toggle / D Flip-Flop nodes. */
  memory(id: string): boolean {
    return this.state.get(id)?.mem ?? false;
  }
  isSpawner(id: string): boolean {
    return this.spawners.has(id) && this.byId.get(id)?.type === 0;
  }
  /** Spawner: whether an enemy is there now (only meaningful while the spawner is ON). */
  enemyAlive(id: string): boolean {
    const r = this.state.get(id)?.respawnAt;
    return r === null || r === undefined || this._time >= r;
  }
  /** Spawner: ms until the next enemy appears, or null if one is there. */
  respawnIn(id: string): number | null {
    const r = this.state.get(id)?.respawnAt ?? null;
    return r === null || this._time >= r ? null : r - this._time;
  }
  hasInputs(id: string): boolean {
    const s = this.sources.get(id);
    return !!s && s[0].length + s[1].length > 0;
  }

  // ------------------------------------------------------------------ user actions

  /** Put every node back to its starting state and time to 0. */
  reset(): void {
    this.state = new Map();
    this.out = new Map();
    this.stored = new Map();
    for (const n of this.nodes) {
      this.state.set(n.id, { lastIn: [false, false], mem: false, since: null, mode: 'auto', pulseUntil: -1, respawnAt: null });
      this.out.set(n.id, false);
    }
    this._time = 0;
    this._log = [];
    this.settle(false);
    this._changed = new Set();
    this._waves = [];
  }

  /** Force a World Object's output ON / OFF, or back to following its inputs ('auto'). */
  setObject(id: string, mode: ObjectMode): void {
    const s = this.state.get(id);
    if (!s || this.byId.get(id)?.type !== 0) return;
    s.mode = mode;
    s.pulseUntil = -1;
    this.refresh(id);
    this.note(id, mode === 'auto' ? 'set to automatic' : `switched ${mode.toUpperCase()}`);
  }

  /** Push a World Object like a button: its output is ON for `pulseMs`. */
  push(id: string): void {
    const s = this.state.get(id);
    if (!s || this.byId.get(id)?.type !== 0) return;
    s.mode = 'auto';
    s.pulseUntil = this._time + this.pulseMs;
    this.refresh(id);
    this.note(id, 'pushed');
  }

  /**
   * Defeat the enemy of an active Spawner: its output goes OFF until the next enemy spawns after the
   * Spawn Timeout. Returns false when there is nothing to defeat (not a spawner, OFF, or no enemy yet).
   */
  defeat(id: string): boolean {
    const s = this.state.get(id);
    if (!s || !this.isSpawner(id) || !this.isOn(id)) return false;
    // The graph first sees the defeat in the next tick; the Spawn Timeout runs from then.
    // A timeout of 0 respawns at once in the game (user-confirmed); here it still leaves one OFF tick
    // (ASSUMPTION: too short to see in game) so the graph can react to the defeat.
    s.respawnAt = this._time + this.tickMs + Math.max(this.tickMs, this.spawners.get(id) ?? 0);
    this.refresh(id);
    this.note(id, 'enemy defeated');
    return true;
  }

  /** Show a user action on a World Object at once (the rest of the graph reacts in the next tick). */
  private refresh(id: string): void {
    const v = this.evaluate(this.byId.get(id)!, (x) => this.isOn(x)).on;
    if (v !== this.isOn(id)) {
      this.out.set(id, v);
      this._changed = new Set([id]);
      this._waves = [];
    }
  }

  private note(id: string, cause: string): void {
    this.pushLog({ t: this._time, nodeId: id, on: this.isOn(id), cause });
  }

  private pushLog(e: SimEvent): void {
    this._log.push(e);
    if (this._log.length > MAX_LOG) this._log.splice(0, this._log.length - MAX_LOG);
  }

  // ------------------------------------------------------------------ running

  /** Advance one tick. Returns the ids whose output changed. */
  step(): ReadonlySet<string> {
    this._time += this.tickMs;
    this.settle(true);
    return this._changed;
  }

  /**
   * Let signals settle at the current time, then commit node state. Each round evaluates the nodes in
   * link order using the newest values (so a graph without loops settles in one round); rounds repeat
   * until nothing changes, or until a loop has had enough rounds to show it keeps oscillating.
   * `waves` are rebuilt afterwards from the final changes, ordered by link depth, for display.
   */
  private settle(log: boolean): void {
    const before = this.out;
    const cur = new Map(before);
    const waves: ReadonlySet<string>[] = [];
    this.work = new Map();
    this.toggleWork = new Map();
    for (const n of this.nodes) {
      const st = this.state.get(n.id)!;
      if (n.type === 8) this.work.set(n.id, st.mem);
      if (n.type === 9) this.toggleWork.set(n.id, { mem: st.mem, seen: [...st.lastIn] });
    }
    const maxRounds = this.nodes.length + 2;
    for (let round = 0; round < maxRounds; round++) {
      let same = true;
      for (const n of this.order) {
        const v = this.evaluate(n, (x) => cur.get(x) ?? false).on;
        if (v !== (cur.get(n.id) ?? false)) {
          cur.set(n.id, v);
          same = false;
        }
      }
      if (same) break;
    }
    // Display waves: a changed node appears one step after the latest changed node feeding it.
    const depth = new Map<string, number>();
    for (const n of this.order) {
      if ((cur.get(n.id) ?? false) === (before.get(n.id) ?? false)) continue;
      const [up, lo] = this.sources.get(n.id)!;
      let d = 0;
      for (const src of [...up, ...lo]) {
        const ds = depth.get(src);
        if (ds !== undefined) d = Math.max(d, ds + 1);
      }
      depth.set(n.id, d);
    }
    const maxDepth = Math.max(-1, ...depth.values());
    for (let i = 0; i <= maxDepth; i++) {
      const m = new Map(before);
      for (const [id, d] of depth) if (d <= i) m.set(id, cur.get(id) ?? false);
      waves.push(onSet(m));
    }
    // commit memory / timers from the settled inputs
    const get: Get = (x) => cur.get(x) ?? false;
    let reset = false;
    for (const n of this.nodes) {
      const st = this.state.get(n.id)!;
      const e = this.evaluate(n, get);
      if (e.mem !== undefined) st.mem = e.mem;
      if (e.since !== undefined) st.since = e.since;
      if (e.respawnAt !== undefined) st.respawnAt = e.respawnAt;
      if (n.type === 16 && this.rising(n.id, 0, get)) reset = true;
    }
    for (const n of this.nodes) {
      this.state.get(n.id)!.lastIn = [this.slotIn(n.id, 0, get), this.slotIn(n.id, 1, get)];
    }
    this.stored = new Map([...this.saves].map(([c, ids]) => [c, ids.some((id) => this.slotIn(id, 0, get))]));
    this._changed = new Set();
    for (const [id, v] of cur) {
      if (v !== (before.get(id) ?? false)) {
        this._changed.add(id);
        if (log) this.pushLog({ t: this._time, nodeId: id, on: v });
      }
    }
    this.out = cur;
    this.work = null;
    this.toggleWork = null;
    this._waves = this._changed.size > 0 ? waves : [];
    if (reset) {
      // ASSUMPTION: Global Reset clears all memory and timers in this graph (the game resets every graph).
      for (const st of this.state.values()) {
        st.mem = false;
        st.since = null;
      }
      if (log) this.pushLog({ t: this._time, nodeId: '', on: false, cause: 'Global Reset' });
    }
  }

  private slotIn(id: string, slot: 0 | 1, get: Get): boolean {
    return this.sources.get(id)![slot].some(get);
  }
  private rising(id: string, slot: 0 | 1, get: Get): boolean {
    return this.slotIn(id, slot, get) && !this.state.get(id)!.lastIn[slot];
  }

  /**
   * Output of `n` at the current time given its inputs' outputs (`get`), plus the memory / timer it
   * would keep. Pure: committed state is only changed by `settle`.
   */
  private evaluate(n: SparkNode, get: Get): Eval {
    const st = this.state.get(n.id)!;
    const ins = this.sources.get(n.id)![0].map(get);
    const any = ins.some(Boolean);
    const upper = this.slotIn(n.id, 0, get);
    const lower = this.slotIn(n.id, 1, get);
    const t = this._time;
    const dur = this.durations.get(n.id) ?? [];
    switch (n.type) {
      case 0: // World Object
        if (this.spawners.has(n.id)) {
          // Spawner: its input (or the forced mode) switches it; ON while switched on and its enemy lives.
          // User-confirmed: a spawner with nothing linked to it is off; switching it off despawns the enemy,
          // and switching it on again spawns a new one at once (no Spawn Timeout).
          const enabled = st.mode === 'on' || (st.mode === 'auto' && (any || t <= st.pulseUntil));
          if (!enabled) return { on: false, respawnAt: null };
          const alive = st.respawnAt === null || t >= st.respawnAt;
          return { on: alive, respawnAt: alive ? null : st.respawnAt };
        }
        if (st.mode === 'on') return { on: true };
        if (st.mode === 'off') return { on: false };
        // ASSUMPTION: an object driven by links passes its input on (e.g. an open door outputs ON).
        return { on: t <= st.pulseUntil || any };
      case 1: {
        // Hold: ON while the input is ON, and for `delay` after it went ON.
        const since = this.rising(n.id, 0, get) ? t : st.since;
        return { on: upper || (since !== null && t - since < (dur[0] ?? 0)), since };
      }
      case 2: {
        // Clock: alternates ON/OFF every `interval` while enabled, starting ON.
        // ASSUMPTION: the input enables it; a Clock with nothing linked to it always runs.
        const enabled = this.sources.get(n.id)![0].length === 0 || upper;
        if (!enabled) return { on: false, since: null };
        const since = st.since ?? t;
        const interval = Math.max(this.tickMs, dur[0] ?? 0);
        return { on: Math.floor((t - since) / interval) % 2 === 0, since };
      }
      case 3: // AND (ASSUMPTION: no inputs = OFF)
        return { on: ins.length > 0 && ins.every(Boolean) };
      case 4: // OR
        return { on: any };
      case 5: // NOT
        return { on: !upper };
      case 6: // NAND
        return { on: !(ins.length > 0 && ins.every(Boolean)) };
      case 7: // XOR: exactly one ON
        return { on: ins.filter(Boolean).length === 1 };
      case 8: {
        // D Flip-Flop: LOWER ON samples (and passes on) UPPER; LOWER OFF holds the last sampled value.
        const held = this.work?.get(n.id) ?? st.mem;
        const mem = lower ? upper : held;
        this.work?.set(n.id, mem);
        return { on: mem, mem };
      }
      case 9: {
        // Toggle (user-tested in game, 9-step switch test + Spawner loop): UPPER OFF->ON flips it; LOWER
        // OFF->ON sets it to UPPER's current value. ON->OFF on either input does nothing, and a LOWER held
        // ON does not block toggling.
        // ASSUMPTION: when both go ON in the same round, LOWER is applied last (result = UPPER = ON).
        const w = this.toggleWork?.get(n.id) ?? { mem: st.mem, seen: st.lastIn };
        let mem = w.mem;
        if (upper && !w.seen[0]) mem = !mem;
        if (lower && !w.seen[1]) mem = upper;
        this.toggleWork?.set(n.id, { mem, seen: [upper, lower] });
        return { on: mem, mem };
      }
      case 10: {
        // Timed Trigger: on UPPER OFF->ON, OFF for `delay`, then ON for `interval`. LOWER ON resets.
        if (lower) return { on: false, since: null };
        const since = this.rising(n.id, 0, get) ? t : st.since;
        if (since === null) return { on: false, since };
        const e = t - since;
        const delay = dur[0] ?? 0;
        // ASSUMPTION: an interval of 0 gives a single-tick pulse.
        const interval = Math.max(this.tickMs, dur[1] ?? 0);
        if (e >= delay + interval) return { on: false, since: null };
        return { on: e >= delay, since };
      }
      case 11: // Save Signal: no output (Use Signals read its input)
        return { on: false };
      case 12: {
        // Use Signal: the input of the Save Signal(s) on its channel, as of the previous tick (see `stored`)
        const c = channelOf(n);
        return { on: c !== null && (this.stored.get(c) ?? false) };
      }
      case 13:
        return { on: true };
      case 14:
        return { on: false };
      case 15: // Flank: ON for one tick when its input goes OFF -> ON
        return { on: this.rising(n.id, 0, get) };
      case 16: // Global Reset: no output
        return { on: false };
      default:
        return { on: typeInfo(n.type).outputs && any };
    }
  }
}

/** Kahn's topological order over the links; nodes left in loops follow in their original order. */
function linkOrder(nodes: readonly SparkNode[], sources: ReadonlyMap<string, [string[], string[]]>): SparkNode[] {
  const indeg = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const n of nodes) {
    const [up, lo] = sources.get(n.id)!;
    indeg.set(n.id, up.length + lo.length);
    for (const s of [...up, ...lo]) outs.set(s, [...(outs.get(s) ?? []), n.id]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const done = new Set<string>();
  const order: SparkNode[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    done.add(id);
    order.push(byId.get(id)!);
    for (const t of outs.get(id) ?? []) {
      const d = indeg.get(t)! - 1;
      indeg.set(t, d);
      if (d === 0) queue.push(t);
    }
  }
  for (const n of nodes) if (!done.has(n.id)) order.push(n);
  return order;
}

function onSet(m: ReadonlyMap<string, boolean>): ReadonlySet<string> {
  const s = new Set<string>();
  for (const [k, v] of m) if (v) s.add(k);
  return s;
}
