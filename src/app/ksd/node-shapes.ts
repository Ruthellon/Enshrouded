/**
 * How each node type is drawn and where its connection slots (ports) are. Coordinates are in a
 * local system centred on the node at scale 1; the canvas scales the whole node. Inputs are on
 * the left and the output on the right, like a schematic. No Angular dependency.
 */
import { typeInfo } from './sparkworks-types';

/** Size of a rectangular node. */
export const BOX_W = 112;
export const BOX_H = 52;
/** Radius of a drawn connection slot. */
export const PORT_R = 6.5;
/** Gate symbols are authored in a ±24 box and drawn this much larger. */
export const GATE_SCALE = 1.4;

/** Radius of the box the gate outlines below are authored in. */
export const BASE_RADIUS = 24;
/** Radius of the small inversion circle on NOT and NAND (authoring units). */
export const BUBBLE_RADIUS = 4.5;

export interface GateShape {
  /** Outline of the gate body (authoring units). */
  body: string;
  /** Extra stroke-only curve (the second input line of XOR). */
  extra?: string;
  /** x of the inversion circle (centred on y = 0) for NOT and NAND. */
  bubbleCx?: number;
  /**
   * x where input links meet the symbol, and where the output slot sits (authoring units). For NOT
   * and NAND the output slot is placed just past the inversion circle so the two do not overlap.
   */
  inX: number;
  outX: number;
}

const AND_BODY = 'M-22 -19H0A19 19 0 0 1 0 19H-22Z';
const NAND_BODY = 'M-24 -18H-4A18 18 0 0 1-4 18H-24Z';
const OR_BODY = 'M-24 -19C-6 -19 12 -12 22 0C12 12-6 19-24 19C-17 8-17 -8-24 -19Z';
const XOR_BODY = 'M-20 -19C-4 -19 12 -12 22 0C12 12-4 19-20 19C-13 8-13 -8-20 -19Z';
const XOR_EXTRA = 'M-26 -19C-19 -8-19 8-26 19';
const NOT_BODY = 'M-22 -18L14 0L-22 18Z';

const SHAPES: Readonly<Record<number, GateShape>> = {
  3: { body: AND_BODY, inX: -22, outX: 19 },
  4: { body: OR_BODY, inX: -19, outX: 22 },
  5: { body: NOT_BODY, bubbleCx: 18.5, inX: -22, outX: 28 },
  6: { body: NAND_BODY, bubbleCx: 18.5, inX: -24, outX: 28 },
  7: { body: XOR_BODY, extra: XOR_EXTRA, inX: -24, outX: 22 },
};

/** The gate symbol for a node type, or null when the type is drawn as a rectangle. */
export function gateShape(type: number): GateShape | null {
  return SHAPES[type] ?? null;
}

export interface PortSpec {
  /** Input connection index: 0 = upper (or the only input), 1 = lower. */
  slot: number;
  x: number;
  y: number;
}

export interface NodeLayout {
  kind: 'gate' | 'box';
  /** Half the width / height of the node's clickable area. */
  halfW: number;
  halfH: number;
  inputs: PortSpec[];
  /** The output slot, or null for nodes without outputs. */
  output: { x: number; y: number } | null;
}

/** Where a node's slots are. Inputs follow the game's rules for that type. */
export function nodeLayout(type: number): NodeLayout {
  const info = typeInfo(type);
  const gate = gateShape(type);
  const halfW = gate ? 30 * GATE_SCALE : BOX_W / 2;
  const halfH = gate ? 20 * GATE_SCALE : BOX_H / 2;
  const inX = gate ? gate.inX * GATE_SCALE : -BOX_W / 2;
  const outX = gate ? gate.outX * GATE_SCALE : BOX_W / 2;

  let inputs: PortSpec[] = [];
  if (info.inputs === 'upperLower') {
    inputs = [
      { slot: 0, x: inX, y: -BOX_H / 4 },
      { slot: 1, x: inX, y: BOX_H / 4 },
    ];
  } else if (info.inputs !== 'none') {
    inputs = [{ slot: 0, x: inX, y: 0 }];
  }
  return { kind: gate ? 'gate' : 'box', halfW, halfH, inputs, output: info.outputs ? { x: outX, y: 0 } : null };
}
