import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { GraphCanvas, type ConnectRequest, type LiveState, type Tool } from './graph-canvas/graph-canvas';
import { NodeIcon } from './node-icon/node-icon';
import {
  KsdError,
  buildKsd,
  checksumMismatches,
  graphName,
  logicEquals,
  parseKsd,
  type LogicData,
  type ParsedKsd,
  type SparkGraph,
} from './ksd/ksd-core';
import {
  History,
  type Result,
  type Selection,
  addEdge,
  autoSlot,
  deleteNode,
  deleteNodes,
  duplicateNode,
  edgeKey,
  insertNode,
  moveNode,
  moveNodes,
  selectNodes,
  selectedNodeIds,
  removeEdge,
  reverseEdge,
  setChannel,
  setDuration,
  setEdgeSlot,
  slotOf,
  summarizeChanges,
  validateGraph,
} from './ksd/graph-model';
import {
  CATEGORY_NAMES,
  DURATION_FIELDS,
  INSERTABLE_TYPES,
  MAX_CHANNEL,
  MAX_NODES_PER_GRAPH,
  channelOf,
  formatDuration,
  hasChannel,
  parseDuration,
  readDurations,
  slotLabel,
  typeColor,
  typeInfo,
  type DurationField,
  type InputKind,
} from './ksd/sparkworks-types';

import { indexWorldObjects, outputOnlyObject, worldObjectLabel } from './ksd/world-objects';
import type { OutputOnlyCheck } from './ksd/graph-model';
import { GraphSim, type ObjectMode } from './ksd/simulator';

/** The Test speed that runs in real time (lower speeds are slowed down so each hop can be followed). */
const REAL_TIME_SPEED = 10;

interface EdgeRow {
  key: string;
  otherId: string;
  otherName: string;
  slotText: string;
}

const INPUT_TEXT: Record<InputKind, string> = {
  none: 'Accepts no inputs.',
  many: 'Accepts any number of inputs.',
  single: 'Accepts one input.',
  upperLower: 'Accepts one input on its UPPER and one on its LOWER connection.',
};

@Component({
  selector: 'app-root',
  imports: [GraphCanvas, NodeIcon],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKeydown($event)' },
})
export class App {
  protected readonly typeColor = typeColor;
  protected readonly channels = Array.from({ length: MAX_CHANNEL }, (_, i) => i + 1);
  protected readonly maxNodes = MAX_NODES_PER_GRAPH;
  protected readonly palette = INSERTABLE_TYPES.map((type) => ({ type, name: typeInfo(type).name, description: typeInfo(type).description }));
  private readonly rand = (): number => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

  // ---- loaded file
  protected readonly parsed = signal<ParsedKsd | null>(null);
  protected readonly fileName = signal('');
  protected readonly exportName = signal('');
  protected readonly original = signal<LogicData | null>(null);
  protected readonly logic = signal<LogicData | null>(null);

  // ---- ui state
  protected readonly graphIndex = signal(0);
  protected readonly selection = signal<Selection>(null);
  protected readonly tool = signal<Tool>('move');
  protected readonly enforceRules = signal(true);
  protected readonly flipY = signal(false);
  protected readonly nodeScale = signal(1);
  protected readonly scaleWithZoom = signal(true);
  protected readonly placeType = signal<number | null>(null);
  protected readonly fitTrigger = signal(0);
  protected readonly error = signal('');
  protected readonly warning = signal('');
  protected readonly notice = signal('');
  /** Chunks whose stored checksum was already wrong when the file was loaded. */
  private loadedMismatches: string[] = [];
  protected readonly dragOver = signal(false);
  private readonly historyVersion = signal(0);
  private history: History<LogicData> | null = null;

  // ---- derived
  protected readonly graph = computed<SparkGraph | null>(() => this.logic()?.graphs[this.graphIndex()] ?? null);
  protected readonly originalGraph = computed<SparkGraph | null>(() => this.original()?.graphs[this.graphIndex()] ?? null);
  protected readonly graphTitle = computed(() => {
    const p = this.parsed();
    const g = this.graph();
    if (!p || !g) return '';
    return graphName(p, g) ?? `Graph ${this.graphIndex()}`;
  });
  protected readonly summary = computed(() => {
    const o = this.original();
    const l = this.logic();
    return o && l ? summarizeChanges(o, l) : null;
  });
  protected readonly canUndo = computed(() => {
    this.historyVersion();
    return this.history?.canUndo ?? false;
  });
  protected readonly canRedo = computed(() => {
    this.historyVersion();
    return this.history?.canRedo ?? false;
  });
  protected readonly fileInfo = computed(() => {
    const p = this.parsed();
    return p ? `${(p.bytes.length / 1024).toFixed(0)} KB` : '';
  });
  protected readonly graphItems = computed(() => {
    const l = this.logic();
    const p = this.parsed();
    const s = this.summary();
    if (!l || !p) return [];
    return l.graphs.map((g, i) => {
      const c = s?.perGraph[i];
      return {
        index: i,
        name: graphName(p, g) ?? '',
        nodes: g.nodes.length,
        edges: g.edges.length,
        changes: c ? c.addedNodes + c.removedNodes + c.movedNodes + c.editedNodes + c.addedEdges + c.removedEdges : 0,
      };
    });
  });
  /** Read-only lookup of World Object links in entity_chunk00 (rebuilt only when a file is loaded). */
  protected readonly objectIndex = computed(() => {
    const p = this.parsed();
    return p ? indexWorldObjects(p) : null;
  });
  /** Rule check: World Objects linked to objects that accept no inputs (Pressure Plates). */
  private readonly outputOnly = computed<OutputOnlyCheck>(() => {
    const idx = this.objectIndex();
    return (n) => outputOnlyObject(idx, n.extra);
  });
  protected readonly nodeCount = computed(() => this.graph()?.nodes.length ?? 0);
  protected readonly atLimit = computed(() => this.nodeCount() >= MAX_NODES_PER_GRAPH);
  protected readonly nodeScalePct = computed(() => Math.round(this.nodeScale() * 100));
  /** Rule problems in the graph being viewed (empty when everything is valid). */
  protected readonly problems = computed(() => {
    const g = this.graph();
    return g ? validateGraph(g, this.outputOnly()) : [];
  });

  protected readonly selectedNode = computed(() => {
    const s = this.selection();
    const g = this.graph();
    if (!s || s.kind !== 'node' || !g) return null;
    return g.nodes.find((n) => n.id === s.id) ?? null;
  });
  protected readonly nodeInfo = computed(() => {
    const n = this.selectedNode();
    if (!n) return null;
    const info = typeInfo(n.type);
    const idx = this.objectIndex();
    const obj = n.type === 0 && n.extra && idx?.available ? idx.lookup(n.extra) : null;
    return {
      object: obj
        ? {
            label: worldObjectLabel(n.extra, obj),
            found: obj.found,
            name: obj.name,
            type: obj.typeName ?? (obj.typeId ? `unknown (${obj.typeId})` : null),
            spawner: obj.spawner
              ? {
                  enemy: obj.spawner.enemyName ?? `unknown enemy (${obj.spawner.enemyId})`,
                  level: obj.spawner.levelOffset > 0 ? `+${obj.spawner.levelOffset}` : String(obj.spawner.levelOffset),
                  timeout: formatDuration(obj.spawner.timeoutMs),
                }
              : null,
          }
        : null,
      name: info.name,
      category: CATEGORY_NAMES[info.category],
      description: info.description,
      color: typeColor(n.type),
      inputsText: outputOnlyObject(idx, n.extra) ? `Accepts no inputs (a ${obj?.typeName} only outputs).` : INPUT_TEXT[info.inputs],
      outputsText: info.outputs ? 'Can output to any number of nodes.' : 'Has no outputs.',
      hasChannel: hasChannel(n.type),
      channel: channelOf(n),
      durations: readDurations(n),
      isObject: n.type === 0,
      objectRef: n.type === 0 ? n.extra : '',
    };
  });
  /** Summary of a multi-node selection (null unless two or more nodes are selected). */
  protected readonly multiInfo = computed(() => {
    const s = this.selection();
    const g = this.graph();
    if (!s || s.kind !== 'nodes' || !g) return null;
    const want = new Set(s.ids);
    const picked = g.nodes.filter((n) => want.has(n.id));
    const counts = new Map<number, number>();
    for (const n of picked) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const links = g.edges.filter((e) => want.has(e.from) || want.has(e.to)).length;
    return {
      count: picked.length,
      links,
      types: [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([type, count]) => ({ type, count, name: typeInfo(type).name, color: typeColor(type) })),
    };
  });
  protected readonly selectedEdge = computed(() => {
    const s = this.selection();
    const g = this.graph();
    if (!s || s.kind !== 'edge' || !g) return null;
    const e = g.edges.find((x) => edgeKey(x) === s.key);
    if (!e) return null;
    const from = g.nodes.find((n) => n.id === e.from);
    const to = g.nodes.find((n) => n.id === e.to);
    const toType = to?.type ?? -1;
    return {
      key: s.key,
      from: e.from,
      to: e.to,
      fromName: from ? typeInfo(from.type).name : '?',
      toName: to ? typeInfo(toType).name : '?',
      slot: slotOf(e.flag),
      slotText: slotLabel(toType, slotOf(e.flag)),
      twoInputs: typeInfo(toType).inputs === 'upperLower',
      flag: e.flag,
    };
  });
  protected readonly nodeConnections = computed(() => {
    const n = this.selectedNode();
    const g = this.graph();
    if (!n || !g) return null;
    const byId = new Map(g.nodes.map((x) => [x.id, x]));
    const incoming: EdgeRow[] = [];
    const outgoing: EdgeRow[] = [];
    for (const e of g.edges) {
      const slot = slotOf(e.flag);
      if (e.to === n.id) {
        const o = byId.get(e.from);
        incoming.push({ key: edgeKey(e), otherId: e.from, otherName: o ? typeInfo(o.type).name : '?', slotText: slotLabel(n.type, slot) });
      }
      if (e.from === n.id) {
        const o = byId.get(e.to);
        outgoing.push({ key: edgeKey(e), otherId: e.to, otherName: o ? typeInfo(o.type).name : '?', slotText: slotLabel(o?.type ?? -1, slot) });
      }
    }
    return { incoming, outgoing };
  });

  // ------------------------------------------------------------------ loading

  protected onFileInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void this.loadFile(f);
    input.value = ''; // allow choosing the same file again
  }

  protected onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(true);
  }
  protected onDragLeave(): void {
    this.dragOver.set(false);
  }
  protected onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) void this.loadFile(f);
  }

  protected async loadFile(file: File): Promise<void> {
    this.error.set('');
    this.warning.set('');
    this.notice.set('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseKsd(bytes);
      const mismatches = checksumMismatches(parsed);
      this.loadedMismatches = mismatches;
      if (mismatches.length > 0) {
        this.warning.set(
          `This file's checksums are already wrong (${mismatches.join(', ')}), so the game will most likely call it corrupted. ` +
            'This happens when a tool changed the file without updating them, for example an export from an older version of this editor. ' +
            'If you have the original file, load that instead.',
        );
      }
      this.parsed.set(parsed);
      this.fileName.set(file.name);
      this.exportName.set(file.name);
      this.original.set(parsed.logic);
      this.logic.set(parsed.logic);
      this.history = new History(parsed.logic);
      this.historyVersion.update((v) => v + 1);
      const firstWithNodes = parsed.logic.graphs.findIndex((g) => g.nodes.length > 0);
      this.stopTest();
      this.graphIndex.set(Math.max(firstWithNodes, 0));
      this.selection.set(null);
      this.tool.set('move');
      this.fitTrigger.update((v) => v + 1);
    } catch (e) {
      this.error.set(e instanceof KsdError ? e.message : `Could not read the file: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ view controls

  protected selectGraph(i: number): void {
    this.stopTest();
    this.graphIndex.set(i);
    this.selection.set(null);
    this.notice.set('');
    this.fitTrigger.update((v) => v + 1);
  }
  protected setTool(t: Tool): void {
    this.tool.set(t);
  }
  protected onEnforce(ev: Event): void {
    this.enforceRules.set((ev.target as HTMLInputElement).checked);
  }
  protected onNodeScale(ev: Event): void {
    const v = Number((ev.target as HTMLInputElement).value);
    if (Number.isFinite(v)) this.nodeScale.set(Math.min(1.8, Math.max(0.4, v)));
  }
  /** Choose a node type in the palette and switch to the Add tool. */
  protected chooseNodeType(type: number): void {
    this.placeType.set(type);
    this.tool.set('add');
    this.notice.set('');
  }
  protected onScaleWithZoom(ev: Event): void {
    this.scaleWithZoom.set((ev.target as HTMLInputElement).checked);
  }
  protected onFlip(ev: Event): void {
    this.flipY.set((ev.target as HTMLInputElement).checked);
  }
  protected onExportName(ev: Event): void {
    this.exportName.set((ev.target as HTMLInputElement).value);
  }
  protected fit(): void {
    this.fitTrigger.update((v) => v + 1);
  }
  protected onSelect(s: Selection): void {
    this.selection.set(s);
    this.notice.set('');
  }
  protected selectProblem(p: { key: string | null; nodeId: string | null }): void {
    if (p.key) this.onSelect({ kind: 'edge', key: p.key });
    else if (p.nodeId) this.onSelect({ kind: 'node', id: p.nodeId });
  }
  protected selectEdge(key: string): void {
    this.onSelect({ kind: 'edge', key });
  }

  // ------------------------------------------------------------------ edits

  /** Apply the outcome of a model operation: show the reason if refused, otherwise commit it. */
  private apply(r: Result<LogicData>): boolean {
    if (!r.ok) {
      this.notice.set(r.reason);
      return false;
    }
    this.notice.set('');
    this.logic.set(r.data);
    this.commit();
    return true;
  }

  /** Live update while a node is being dragged (not yet an undo step). */
  protected onNodeMove(moves: { id: string; x: number; y: number }[]): void {
    const l = this.logic();
    if (l) this.logic.set(moveNodes(l, this.graphIndex(), moves));
  }
  protected onNodeMoveEnd(): void {
    this.commit();
  }

  protected onPlace(pt: { x: number; y: number }): void {
    const type = this.placeType();
    const l = this.logic();
    if (type === null || !l) return;
    const r = insertNode(l, this.graphIndex(), { type, x: pt.x, y: pt.y }, this.enforceRules(), this.rand);
    if (!r.ok) {
      this.notice.set(r.reason);
      return;
    }
    this.logic.set(r.data.data);
    this.commit();
    this.selection.set({ kind: 'node', id: r.data.id });
    let msg = `Added ${typeInfo(type).name}.`;
    if (DURATION_FIELDS[type]) msg += ' Set its time in the Selection panel.';
    if (type === 0) msg += ' It has no object assigned yet; link it to an object inside the game.';
    this.notice.set(msg);
  }

  protected duplicateSelectedNode(): void {
    const n = this.selectedNode();
    const l = this.logic();
    if (!n || !l) return;
    const r = duplicateNode(l, this.graphIndex(), n.id, this.enforceRules(), this.rand);
    if (!r.ok) {
      this.notice.set(r.reason);
      return;
    }
    this.logic.set(r.data.data);
    this.commit();
    this.selection.set({ kind: 'node', id: r.data.id });
    this.notice.set(
      n.type === 0
        ? 'Added a new World Object with no object assigned (an object is never used twice in a graph). Its links were not copied.'
        : `Duplicated ${typeInfo(n.type).name}. Its links were not copied.`,
    );
  }

  protected deleteSelectedNode(): void {
    const n = this.selectedNode();
    const l = this.logic();
    if (!n || !l) return;
    const r = deleteNode(l, this.graphIndex(), n.id);
    if (!r) return;
    this.logic.set(r.data);
    this.commit();
    this.selection.set(null);
    let msg = `Deleted ${typeInfo(n.type).name}`;
    if (r.removedEdges > 0) msg += ` and its ${r.removedEdges} link(s)`;
    msg += '.';
    if (r.orphanedUses > 0) msg += ` ${r.orphanedUses} Use Signal(s) on that channel no longer have a Save Signal.`;
    this.notice.set(msg);
  }

  /** Delete every node in a multi-selection (and every link touching them) as one undo step. */
  protected deleteSelectedNodes(): void {
    const s = this.selection();
    const l = this.logic();
    if (!s || s.kind !== 'nodes' || !l) return;
    const r = deleteNodes(l, this.graphIndex(), s.ids);
    if (!r) return;
    this.logic.set(r.data);
    this.commit();
    this.selection.set(null);
    let msg = `Deleted ${r.removedNodes} node(s)`;
    if (r.removedEdges > 0) msg += ` and ${r.removedEdges} link(s)`;
    msg += '.';
    if (r.orphanedUses > 0) msg += ` ${r.orphanedUses} Use Signal(s) no longer have a Save Signal on their channel.`;
    this.notice.set(msg);
  }

  protected selectAllNodes(): void {
    const g = this.graph();
    if (g) this.onSelect(selectNodes(g.nodes.map((n) => n.id)));
  }

  protected onPosInput(axis: 'x' | 'y', ev: Event): void {
    const n = this.selectedNode();
    const l = this.logic();
    const v = Number((ev.target as HTMLInputElement).value);
    if (!n || !l || !Number.isFinite(v)) return;
    this.logic.set(moveNode(l, this.graphIndex(), n.id, axis === 'x' ? v : n.x, axis === 'y' ? v : n.y));
    this.commit();
  }

  protected onChannel(ev: Event): void {
    const n = this.selectedNode();
    const l = this.logic();
    const el = ev.target as HTMLSelectElement;
    if (!n || !l) return;
    if (!this.apply(setChannel(l, this.graphIndex(), n.id, Number(el.value), this.enforceRules()))) {
      el.value = String(channelOf(n) ?? 1); // put the box back to the real value
    }
  }

  protected onDuration(field: DurationField, ev: Event): void {
    const n = this.selectedNode();
    const l = this.logic();
    const el = ev.target as HTMLInputElement;
    if (!n || !l) return;
    const current = readDurations(n).find((d) => d.field === field);
    const ms = parseDuration(el.value);
    if (ms === null) {
      this.notice.set('Enter a time as minutes:seconds:milliseconds (for example 0:5:000) or as seconds (for example 1.5).');
      el.value = current ? current.text : formatDuration(0);
      return;
    }
    if (!this.apply(setDuration(l, this.graphIndex(), n.id, field, ms))) {
      el.value = current ? current.text : formatDuration(0);
    }
  }

  /**
   * Link two nodes. When the link was dropped on a specific input slot, that slot is used;
   * when it was dropped on a node body, a two-input node takes its first free input.
   */
  protected onConnect(c: ConnectRequest): void {
    const l = this.logic();
    const g = this.graph();
    if (!l || !g) return;
    const target = g.nodes.find((n) => n.id === c.to);
    const twoInputs = !!target && typeInfo(target.type).inputs === 'upperLower';
    const slot = c.slot !== undefined ? c.slot : twoInputs ? autoSlot(g, c.to) : 0;
    const flag = slot << 8;
    if (this.apply(addEdge(l, this.graphIndex(), c.from, c.to, flag, this.enforceRules(), this.outputOnly()))) {
      this.selection.set({ kind: 'edge', key: edgeKey({ from: c.from, to: c.to, flag }) });
    }
  }

  protected deleteEdge(key: string): void {
    const l = this.logic();
    if (!l) return;
    const next = removeEdge(l, this.graphIndex(), key);
    if (!next) return;
    this.notice.set('');
    this.logic.set(next);
    this.commit();
    const s = this.selection();
    if (s && s.kind === 'edge' && s.key === key) this.selection.set(null);
  }
  protected deleteSelectedEdge(): void {
    const e = this.selectedEdge();
    if (e) this.deleteEdge(e.key);
  }

  /** Apply an edit to the selected edge and keep it selected (its key changes when it is edited). */
  private editSelectedEdge(op: (l: LogicData, gi: number, key: string, enforce: boolean) => Result<LogicData>): void {
    const e = this.selectedEdge();
    const l = this.logic();
    const g = this.graph();
    if (!e || !l || !g) return;
    const idx = g.edges.findIndex((x) => edgeKey(x) === e.key);
    const gi = this.graphIndex();
    if (this.apply(op(l, gi, e.key, this.enforceRules()))) {
      const edited = this.logic()?.graphs[gi].edges[idx];
      if (edited) this.selection.set({ kind: 'edge', key: edgeKey(edited) });
    }
  }
  protected reverseSelectedEdge(): void {
    this.editSelectedEdge((l, gi, key, enforce) => reverseEdge(l, gi, key, enforce, this.outputOnly()));
  }
  protected setSelectedEdgeSlot(slot: number): void {
    const e = this.selectedEdge();
    if (!e || e.slot === slot) return;
    this.editSelectedEdge((l, gi, key, enforce) => setEdgeSlot(l, gi, key, slot, enforce, this.outputOnly()));
  }

  protected revertGraph(): void {
    const l = this.logic();
    const o = this.original();
    if (!l || !o) return;
    const gi = this.graphIndex();
    if (l.graphs[gi] === o.graphs[gi]) return;
    this.notice.set('');
    this.logic.set({ ...l, graphs: l.graphs.map((g, i) => (i === gi ? o.graphs[i] : g)) });
    this.commit();
    this.selection.set(null);
  }

  // ------------------------------------------------------------------ test mode

  /**
   * Speeds offered for playback. 1x = one tick (one link hop, 50 ms of game time) every 0.5 s;
   * 10x = real time.
   */
  protected readonly speeds = [0.25, 0.5, 1, 2, 5, 10];
  protected readonly testing = signal(false);
  protected readonly playing = signal(false);
  protected readonly speed = signal(1);
  private sim: GraphSim | null = null;
  /** Bumped whenever the simulation changes, so the views below recompute. */
  private readonly simVersion = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.pause());
  }

  /**
   * A tick's change is shown spreading link by link: these are the remaining in-between ON-sets
   * (from GraphSim.waves), one shown per frame before time moves on.
   */
  private pendingWaves: ReadonlySet<string>[] = [];
  /** The in-between state being shown, and the one before it (null = show the simulation's state). */
  private readonly wave = signal<{ on: ReadonlySet<string>; changed: ReadonlySet<string> } | null>(null);

  protected readonly live = computed<LiveState | null>(() => {
    this.simVersion();
    const s = this.sim;
    if (!this.testing() || !s) return null;
    return this.wave() ?? { on: s.onNodes(), changed: s.changed() };
  });
  protected readonly simTime = computed(() => {
    this.simVersion();
    return ((this.sim?.time ?? 0) / 1000).toFixed(2);
  });
  /** Newest events first, with readable node names. */
  protected readonly simLog = computed(() => {
    this.simVersion();
    const s = this.sim;
    if (!s) return [];
    return s
      .log()
      .slice(-60)
      .reverse()
      .map((e, i) => ({
        i,
        t: (e.t / 1000).toFixed(2),
        name: e.nodeId ? this.nodeLabel(e.nodeId) : '',
        text: e.cause ?? (e.on ? 'ON' : 'OFF'),
        on: e.on,
        user: !!e.cause,
        id: e.nodeId,
      }));
  });
  /** Live details of the selected node while testing. */
  protected readonly testNode = computed(() => {
    this.simVersion();
    const n = this.selectedNode();
    const s = this.sim;
    if (!n || !s || !this.testing()) return null;
    const info = typeInfo(n.type);
    const [upper, lower] = s.inputs(n.id);
    const obj = n.type === 0;
    const spawner = obj && s.isSpawner(n.id);
    const respawn = spawner ? s.respawnIn(n.id) : null;
    return {
      spawner,
      enemy: !spawner ? null : !s.isOn(n.id) && respawn === null ? 'none (spawner OFF)' : respawn === null ? 'alive' : `defeated, next in ${formatDuration(respawn)}`,
      id: n.id,
      name: this.nodeLabel(n.id),
      on: s.isOn(n.id),
      isObject: obj,
      driven: s.hasInputs(n.id),
      mode: obj ? s.objectMode(n.id) : 'auto',
      twoInputs: info.inputs === 'upperLower',
      hasInput: info.inputs !== 'none' && s.hasInputs(n.id),
      upper,
      lower,
      memory: n.type === 8 || n.type === 9 ? s.memory(n.id) : null,
    };
  });

  /** A readable name for a node: a World Object's in-game name, otherwise its type. */
  private nodeLabel(id: string): string {
    const n = this.graph()?.nodes.find((x) => x.id === id);
    if (!n) return id;
    if (n.type !== 0) return typeInfo(n.type).name;
    const idx = this.objectIndex();
    return idx?.available ? worldObjectLabel(n.extra, idx.lookup(n.extra)) : 'World Object';
  }

  protected toggleTest(): void {
    if (this.testing()) this.stopTest();
    else this.startTest();
  }
  private startTest(): void {
    const g = this.graph();
    if (!g) return;
    // Spawners behave differently (see GraphSim): pass them on with their Spawn Timeout.
    const spawners = new Map<string, number>();
    const idx = this.objectIndex();
    if (idx?.available) {
      for (const n of g.nodes) {
        const sp = n.type === 0 ? idx.lookup(n.extra).spawner : null;
        if (sp) spawners.set(n.id, sp.timeoutMs);
      }
    }
    this.sim = new GraphSim(g, { spawners });
    this.testing.set(true);
    this.notice.set('');
    this.simVersion.update((v) => v + 1);
    this.play();
  }
  protected stopTest(): void {
    this.pause();
    this.clearWaves();
    this.sim = null;
    this.testing.set(false);
    this.simVersion.update((v) => v + 1);
  }
  protected play(): void {
    if (!this.sim) return;
    this.pause();
    const s = this.sim;
    this.timer = setInterval(() => this.advance(), (s.tickMs * REAL_TIME_SPEED) / this.speed());
    this.playing.set(true);
  }
  protected pause(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.playing.set(false);
  }
  protected togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }
  protected stepOnce(): void {
    this.pause();
    this.advance();
  }
  /** One frame: show the next link of a spreading change, or else advance the game by one tick. */
  private advance(): void {
    const s = this.sim;
    if (!s) return;
    if (this.pendingWaves.length === 0) {
      s.step();
      const waves = s.waves();
      // with only one round there is nothing in between to show
      this.pendingWaves = waves.length > 1 ? waves.slice() : [];
      this.lastShown = this.live()?.on ?? new Set();
    }
    const next = this.pendingWaves.shift();
    if (next && this.pendingWaves.length > 0) {
      const prev = this.lastShown;
      const changed = new Set([...next].filter((x) => !prev.has(x)).concat([...prev].filter((x) => !next.has(x))));
      this.wave.set({ on: next, changed });
      this.lastShown = next;
    } else {
      this.pendingWaves = [];
      this.wave.set(null);
    }
    this.simVersion.update((v) => v + 1);
  }
  private lastShown: ReadonlySet<string> = new Set();
  private clearWaves(): void {
    this.pendingWaves = [];
    this.wave.set(null);
  }
  protected resetTest(): void {
    this.clearWaves();
    this.sim?.reset();
    this.simVersion.update((v) => v + 1);
  }
  protected onSpeed(ev: Event): void {
    const v = Number((ev.target as HTMLSelectElement).value);
    if (!Number.isFinite(v) || v <= 0) return;
    this.speed.set(v);
    if (this.playing()) this.play();
  }

  /**
   * A node was clicked while testing. World Objects with nothing linked into them are things the
   * player operates (switch buttons, pressure plates, trigger zones, ...): a click switches them ON,
   * and the next click OFF. Switch Buttons latch like this in the game: the "Encounter 2 Passcode"
   * graph ANDs eight of them, which only works if they stay ON. "Push" in the panel gives a short pulse.
   */
  protected onInteract(id: string): void {
    const s = this.sim;
    const n = this.graph()?.nodes.find((x) => x.id === id);
    if (!s || !n || n.type !== 0) return;
    if (s.isSpawner(id)) {
      // clicking a Spawner = defeating the enemy it spawned
      this.defeatEnemy(id);
      return;
    }
    if (s.hasInputs(id)) return;
    this.clearWaves();
    s.setObject(id, s.objectMode(id) === 'on' ? 'off' : 'on');
    this.simVersion.update((v) => v + 1);
  }
  protected defeatEnemy(id: string): void {
    this.clearWaves();
    this.sim?.defeat(id);
    this.simVersion.update((v) => v + 1);
  }
  protected pushObject(id: string): void {
    this.clearWaves();
    this.sim?.push(id);
    this.simVersion.update((v) => v + 1);
  }
  protected setObjectMode(id: string, mode: ObjectMode): void {
    this.clearWaves();
    this.sim?.setObject(id, mode);
    this.simVersion.update((v) => v + 1);
  }
  protected selectNodeById(id: string): void {
    if (id) this.onSelect({ kind: 'node', id });
  }

  // ------------------------------------------------------------------ history

  private commit(): void {
    const l = this.logic();
    if (!l || !this.history) return;
    this.history.push(l);
    this.historyVersion.update((v) => v + 1);
  }
  protected undo(): void {
    if (!this.history?.canUndo) return;
    this.logic.set(this.history.undo());
    this.afterHistoryMove();
  }
  protected redo(): void {
    if (!this.history?.canRedo) return;
    this.logic.set(this.history.redo());
    this.afterHistoryMove();
  }
  private afterHistoryMove(): void {
    this.historyVersion.update((v) => v + 1);
    this.notice.set('');
    const s = this.selection();
    const g = this.graph();
    if (s && g) {
      if (s.kind === 'edge') {
        if (!g.edges.some((e) => edgeKey(e) === s.key)) this.selection.set(null);
      } else {
        // keep whichever selected nodes still exist
        const present = new Set(g.nodes.map((n) => n.id));
        const ids = selectedNodeIds(s);
        const kept = ids.filter((id) => present.has(id));
        if (kept.length !== ids.length) this.selection.set(selectNodes(kept));
      }
    }
  }

  protected onKeydown(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (this.testing()) {
      // while testing: Space plays/pauses, other edit shortcuts are off
      if (ev.key === ' ' && !typing) {
        ev.preventDefault();
        this.togglePlay();
      }
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 'z') {
      if (typing) return;
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y') {
      if (typing) return;
      ev.preventDefault();
      this.redo();
    } else if (mod && key === 'a') {
      if (typing || !this.graph()) return;
      ev.preventDefault();
      this.selectAllNodes();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !typing) {
      if (this.selectedEdge()) {
        ev.preventDefault();
        this.deleteSelectedEdge();
      } else if (this.multiInfo()) {
        ev.preventDefault();
        this.deleteSelectedNodes();
      } else if (this.selectedNode()) {
        ev.preventDefault();
        this.deleteSelectedNode();
      }
    }
  }

  // ------------------------------------------------------------------ export

  protected exportFile(): void {
    const p = this.parsed();
    const l = this.logic();
    if (!p || !l) return;
    this.error.set('');
    try {
      const bytes = buildKsd(p, l);
      // Read the result back and make sure it matches what the editor shows before offering it.
      const check = parseKsd(bytes);
      if (!logicEquals(check.logic, l)) {
        throw new KsdError('Verification failed: the rebuilt file does not read back the same as the editor. Nothing was downloaded.');
      }
      const already = new Set(this.loadedMismatches);
      const broken = checksumMismatches(check).filter((n) => !already.has(n));
      if (broken.length > 0) {
        throw new KsdError(`Verification failed: the checksum of ${broken.join(', ')} does not match. Nothing was downloaded.`);
      }
      this.download(bytes, this.exportName().trim() || this.fileName() || 'world.ksd');
      const s = this.summary();
      const rules = l.graphs.reduce((n, g) => n + validateGraph(g, this.outputOnly()).length, 0);
      const warn = rules > 0 ? ` Warning: ${rules} Sparkworks rule problem(s) remain in the file.` : '';
      this.notice.set(
        (s && s.total > 0
          ? `Exported, re-read and checksum-verified: ${s.addedNodes} node(s) added, ${s.removedNodes} removed, ${s.movedNodes} moved, ${s.editedNodes} setting(s) changed; ${s.addedEdges} link(s) added, ${s.removedEdges} removed.`
          : 'Exported. There were no edits, so the file is identical to the one you loaded.') + warn,
      );
    } catch (e) {
      this.error.set(e instanceof KsdError ? e.message : `Export failed: ${(e as Error).message}`);
    }
  }

  private download(bytes: Uint8Array, name: string): void {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
