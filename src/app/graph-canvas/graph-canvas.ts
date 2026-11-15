import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { SparkGraph } from '../ksd/ksd-core';
import { edgeKey, slotOf, type Selection } from '../ksd/graph-model';
import {
  type HitBox,
  type Pt,
  type Viewport,
  boxAt,
  fitViewport,
  linkPath,
  nodeAt,
  setFlipY,
  toScreen,
  toWorld,
  zoomAt,
} from '../ksd/graph-geometry';
import { BOX_H, BOX_W, BUBBLE_RADIUS, GATE_SCALE, PORT_R, gateShape, nodeLayout } from '../ksd/node-shapes';
import { formatDuration, nodeSubtitle, readDurations, channelOf, slotLabel, typeColor, typeInfo } from '../ksd/sparkworks-types';
import { NodeIcon } from '../node-icon/node-icon';

export type Tool = 'move' | 'connect' | 'add';

/** A request to link two nodes. `slot` is set when the link was dropped on a specific input slot. */
export interface ConnectRequest {
  from: string;
  to: string;
  slot?: number;
}

const DRAG_THRESHOLD = 3;
/** Extra pixels around a slot that still count as hitting it. */
const PORT_SLOP = 5;
const round1 = (n: number): number => Math.round(n * 10) / 10;

type DragState =
  | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number; moved: boolean }
  | { kind: 'node'; id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean }
  | { kind: 'connect'; fromId: string };

/**
 * SVG view of one Sparkworks graph. It owns pan/zoom and pointer handling, and reports edits
 * through outputs; the parent decides what to do with them.
 */
@Component({
  selector: 'app-graph-canvas',
  templateUrl: './graph-canvas.html',
  styleUrl: './graph-canvas.css',
  imports: [NodeIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown.escape)': 'cancelPending()' },
})
export class GraphCanvas implements AfterViewInit, OnDestroy {
  readonly graph = input.required<SparkGraph>();
  /** The same graph as originally loaded, used to highlight moved nodes and new links. */
  readonly original = input<SparkGraph | null>(null);
  readonly tool = input<Tool>('move');
  readonly selection = input<Selection>(null);
  readonly flipY = input(false);
  /** Multiplier for the drawn size of nodes (1 = default). */
  readonly nodeScale = input(1);
  /** Node type that the Add tool places when the background is clicked. */
  readonly placeType = input<number | null>(null);
  /** Change this number to make the canvas re-fit the graph to the view. */
  readonly fitTrigger = input(0);

  readonly selectionChange = output<Selection>();
  readonly nodeMove = output<{ id: string; x: number; y: number }>();
  readonly nodeMoveEnd = output<void>();
  readonly connect = output<ConnectRequest>();
  /** The Add tool was clicked on empty background at these world coordinates. */
  readonly place = output<{ x: number; y: number }>();

  private readonly svgRef = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private readonly zone = inject(NgZone);
  private resizeObserver: ResizeObserver | null = null;
  private drag: DragState | null = null;

  protected readonly width = signal(0);
  protected readonly height = signal(0);
  protected readonly vp = signal<Viewport>({ scale: 1, tx: 0, ty: 0, flipY: false });
  protected readonly panning = signal(false);
  protected readonly rubber = signal<{ fromId: string; x: number; y: number } | null>(null);
  protected readonly pendingFrom = signal<string | null>(null);
  /** The node (body) a link being dragged would land on. */
  protected readonly hoverTarget = signal<string | null>(null);
  /** The input slot a link being dragged would land on. */
  protected readonly hoverPort = signal<{ id: string; slot: number } | null>(null);
  private readonly sizeKnown = computed(() => this.width() > 0 && this.height() > 0);

  protected readonly portRadius = PORT_R;
  protected readonly bubbleRadius = BUBBLE_RADIUS;
  protected readonly gateScale = GATE_SCALE;
  protected readonly boxW = BOX_W;
  protected readonly boxH = BOX_H;
  protected readonly placeName = computed(() => {
    const t = this.placeType();
    return t === null ? '' : typeInfo(t).name;
  });

  private readonly originalPos = computed(() => {
    const o = this.original();
    return new Map((o?.nodes ?? []).map((n) => [n.id, n]));
  });
  private readonly originalKeys = computed(() => {
    const o = this.original();
    return o ? new Set(o.edges.map(edgeKey)) : null;
  });

  protected readonly nodes = computed(() => {
    const v = this.vp();
    const orig = this.originalPos();
    const hasOriginal = this.original() !== null;
    const sel = this.selection();
    const pending = this.pendingFrom();
    const hoverNode = this.hoverTarget();
    const hoverPort = this.hoverPort();
    const s = this.nodeScale();
    return this.graph().nodes.map((n) => {
      const p = toScreen(v, n.x, n.y);
      const o = orig.get(n.id);
      const info = typeInfo(n.type);
      const layout = nodeLayout(n.type);
      const channel = channelOf(n);
      const times = readDurations(n)
        .map((d) => `${d.label} ${formatDuration(d.ms)}`)
        .join(', ');
      const details = [channel !== null ? `channel ${channel}` : '', times].filter(Boolean).join(' | ');
      const inputs = layout.inputs.map((pt) => ({
        slot: pt.slot,
        x: pt.x,
        y: pt.y,
        sx: p.x + pt.x * s,
        sy: p.y + pt.y * s,
        lower: pt.slot === 1,
        hover: hoverPort !== null && hoverPort.id === n.id && hoverPort.slot === pt.slot,
        tip:
          info.inputs === 'upperLower'
            ? `${slotLabel(n.type, pt.slot)} input`
            : info.inputs === 'many'
              ? 'Input (any number of links)'
              : 'Input',
      }));
      const out = layout.output
        ? { x: layout.output.x, y: layout.output.y, sx: p.x + layout.output.x * s, sy: p.y + layout.output.y * s }
        : null;
      return {
        id: n.id,
        type: n.type,
        x: p.x,
        y: p.y,
        transform: `translate(${p.x} ${p.y}) scale(${s})`,
        color: typeColor(n.type),
        gate: gateShape(n.type),
        isGate: layout.kind === 'gate',
        title: info.name,
        sub: nodeSubtitle(n),
        halfW: layout.halfW,
        halfH: layout.halfH,
        ringW: layout.halfW + 7,
        ringH: layout.halfH + 7,
        inputs,
        out,
        added: hasOriginal && !o,
        moved:
          !!o &&
          (Math.fround(o.x) !== Math.fround(n.x) || Math.fround(o.y) !== Math.fround(n.y) || o.extra !== n.extra),
        selected: sel !== null && sel.kind === 'node' && sel.id === n.id,
        pending: pending === n.id,
        target: hoverNode === n.id,
        tip: `${info.name}${details ? ' (' + details + ')' : ''}  |  id ${n.id}`,
      };
    });
  });

  protected readonly edges = computed(() => {
    const g = this.graph();
    const sel = this.selection();
    const origKeys = this.originalKeys();
    const s = this.nodeScale();
    const views = new Map(this.nodes().map((n) => [n.id, n]));
    return g.edges.map((e) => {
      const a = views.get(e.from);
      const b = views.get(e.to);
      const key = edgeKey(e);
      const slot = slotOf(e.flag);
      const selected = sel !== null && sel.kind === 'edge' && sel.key === key;
      const added = origKeys !== null && !origKeys.has(key);
      let d = '';
      if (a && b) {
        // start at the source's output slot, end at the target's matching input slot
        // (falling back to the node's edge if a rule-breaking link points at a slot that is not drawn)
        const from = a.out ?? { sx: a.x + a.halfW * s, sy: a.y };
        const into = b.inputs.find((p) => p.slot === slot) ?? b.inputs[0] ?? { sx: b.x - b.halfW * s, sy: b.y };
        d = linkPath(from.sx, from.sy, into.sx, into.sy).d;
      }
      const kind = selected ? 'selected' : added ? 'added' : slot !== 0 ? 'slot1' : 'normal';
      return { key, d, slot, selected, added, marker: `url(#arrow-${kind})` };
    });
  });

  protected readonly rubberLine = computed(() => {
    const r = this.rubber();
    if (!r) return null;
    const n = this.nodes().find((x) => x.id === r.fromId);
    if (!n) return null;
    const from = n.out ?? { sx: n.x, sy: n.y };
    return { x1: from.sx, y1: from.sy, x2: r.x, y2: r.y };
  });

  protected readonly legend = computed(() => {
    const counts = new Map<number, number>();
    for (const n of this.graph().nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([type, count]) => ({ type, count, name: typeInfo(type).name }));
  });

  constructor() {
    // Re-fit when asked to, and once as soon as the canvas has a size.
    effect(() => {
      this.fitTrigger();
      this.sizeKnown();
      untracked(() => {
        this.cancelPending();
        this.fit();
      });
    });
    // Flip the y direction without jumping.
    effect(() => {
      const f = this.flipY();
      untracked(() => this.vp.update((v) => setFlipY(v, f, this.height() / 2)));
    });
    // Leaving connect mode drops any half-made connection.
    effect(() => {
      if (this.tool() !== 'connect') untracked(() => this.cancelPending());
    });
  }

  ngAfterViewInit(): void {
    const el = this.svgRef().nativeElement;
    const measure = (w: number, h: number) =>
      this.zone.run(() => {
        this.width.set(w);
        this.height.set(h);
      });
    const r = el.getBoundingClientRect();
    measure(r.width, r.height);
    this.resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) measure(box.width, box.height);
    });
    this.resizeObserver.observe(el);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // ------------------------------------------------------------------ public API

  fit(): void {
    const pad = Math.max(60, (BOX_W / 2) * this.nodeScale() + 24);
    this.vp.set(fitViewport(this.graph().nodes, this.width(), this.height(), this.flipY(), pad));
  }

  cancelPending(): void {
    this.pendingFrom.set(null);
    this.rubber.set(null);
    this.hoverTarget.set(null);
    this.hoverPort.set(null);
  }

  protected zoomBy(factor: number): void {
    this.vp.update((v) => zoomAt(v, this.width() / 2, this.height() / 2, factor));
  }

  // ------------------------------------------------------------------ pointer handling

  private local(ev: MouseEvent): Pt {
    const r = this.svgRef().nativeElement.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /** The input slot under a point, if any (slots win over the node body). */
  private hitInputPort(p: Pt, exclude: string | null): { id: string; slot: number } | null {
    const pts: { id: string; x: number; y: number }[] = [];
    for (const n of this.nodes()) {
      if (n.id === exclude) continue;
      for (const pt of n.inputs) pts.push({ id: `${n.id}:${pt.slot}`, x: pt.sx, y: pt.sy });
    }
    const hit = nodeAt(pts, p.x, p.y, PORT_R * this.nodeScale() + PORT_SLOP);
    if (hit === null) return null;
    const i = hit.lastIndexOf(':');
    return { id: hit.slice(0, i), slot: Number(hit.slice(i + 1)) };
  }

  /** The node body under a point, if any. */
  private hitNode(p: Pt, exclude: string | null): string | null {
    const s = this.nodeScale();
    const boxes: HitBox[] = this.nodes()
      .filter((n) => n.id !== exclude)
      .map((n) => ({ id: n.id, x: n.x, y: n.y, halfW: n.halfW * s, halfH: n.halfH * s }));
    return boxAt(boxes, p.x, p.y, 4);
  }

  protected onBackgroundDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const p = this.local(ev);
    const v = this.vp();
    this.drag = { kind: 'pan', sx: p.x, sy: p.y, tx: v.tx, ty: v.ty, moved: false };
    this.panning.set(true);
    this.svgRef().nativeElement.setPointerCapture(ev.pointerId);
  }

  /** Begin dragging a link out of a node (from its output slot, or from its body in Connect mode). */
  private startLink(ev: PointerEvent, fromId: string): void {
    const p = this.local(ev);
    this.pendingFrom.set(fromId);
    this.drag = { kind: 'connect', fromId };
    this.rubber.set({ fromId, x: p.x, y: p.y });
    this.svgRef().nativeElement.setPointerCapture(ev.pointerId);
  }

  protected onNodeDown(ev: PointerEvent, id: string): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const svg = this.svgRef().nativeElement;
    const p = this.local(ev);
    this.selectionChange.emit({ kind: 'node', id });

    if (this.tool() === 'connect') {
      const pending = this.pendingFrom();
      if (pending !== null && pending !== id) {
        // second click of a click-click connection
        this.connect.emit({ from: pending, to: id });
        this.cancelPending();
        return;
      }
      this.startLink(ev, id);
      return;
    }

    const node = this.graph().nodes.find((n) => n.id === id);
    if (!node) return;
    const w = toWorld(this.vp(), p.x, p.y);
    this.drag = { kind: 'node', id, dx: node.x - w.x, dy: node.y - w.y, sx: p.x, sy: p.y, moved: false };
    svg.setPointerCapture(ev.pointerId);
  }

  /** Pressing an output slot always starts a link, whatever the tool. */
  protected onOutputDown(ev: PointerEvent, id: string): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    this.selectionChange.emit({ kind: 'node', id });
    this.startLink(ev, id);
  }

  /** Pressing an input slot completes a click-click link; otherwise it just selects the node. */
  protected onInputDown(ev: PointerEvent, id: string, slot: number): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const pending = this.pendingFrom();
    if (pending !== null && pending !== id) {
      this.connect.emit({ from: pending, to: id, slot });
      this.cancelPending();
      return;
    }
    this.selectionChange.emit({ kind: 'node', id });
  }

  protected onEdgeDown(ev: PointerEvent, key: string): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    this.selectionChange.emit({ kind: 'edge', key });
  }

  protected onPointerMove(ev: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.local(ev);
    if (d.kind === 'pan') {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      this.vp.update((v) => ({ ...v, tx: d.tx + p.x - d.sx, ty: d.ty + p.y - d.sy }));
    } else if (d.kind === 'node') {
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      const w = toWorld(this.vp(), p.x, p.y);
      this.nodeMove.emit({ id: d.id, x: round1(w.x + d.dx), y: round1(w.y + d.dy) });
    } else {
      this.rubber.set({ fromId: d.fromId, x: p.x, y: p.y });
      const port = this.hitInputPort(p, d.fromId);
      this.hoverPort.set(port);
      this.hoverTarget.set(port ? null : this.hitNode(p, d.fromId));
    }
  }

  protected onPointerUp(ev: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.panning.set(false);
    const svg = this.svgRef().nativeElement;
    if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
    if (!d) return;
    const cancelled = ev.type === 'pointercancel';

    if (d.kind === 'pan') {
      if (!d.moved && !cancelled) {
        if (this.tool() === 'add' && this.placeType() !== null) {
          const w = toWorld(this.vp(), d.sx, d.sy);
          this.place.emit({ x: round1(w.x), y: round1(w.y) });
        } else {
          this.selectionChange.emit(null);
          this.cancelPending();
        }
      }
    } else if (d.kind === 'node') {
      if (d.moved) this.nodeMoveEnd.emit();
    } else {
      const p = this.local(ev);
      const port = cancelled ? null : this.hitInputPort(p, d.fromId);
      const body = cancelled || port ? null : this.hitNode(p, d.fromId);
      this.rubber.set(null);
      this.hoverTarget.set(null);
      this.hoverPort.set(null);
      if (port) {
        this.connect.emit({ from: d.fromId, to: port.id, slot: port.slot });
        this.pendingFrom.set(null);
      } else if (body) {
        this.connect.emit({ from: d.fromId, to: body });
        this.pendingFrom.set(null);
      }
      // otherwise the source stays "pending" so the next click on another node completes it
    }
  }

  protected onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const p = this.local(ev);
    const k = ev.deltaMode === 1 ? 0.05 : 0.0015;
    this.vp.update((v) => zoomAt(v, p.x, p.y, Math.exp(-ev.deltaY * k)));
  }
}
