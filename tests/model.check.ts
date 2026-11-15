import { readFileSync } from 'node:fs';
import { parseKsd, buildKsd, logicEquals, type SparkGraph, type SparkNode } from '../src/app/ksd/ksd-core.ts';
import {
  moveNode, addEdge, removeEdge, reverseEdge, setEdgeSlot, setChannel, setDuration, autoSlot, canAddEdge, validateGraph,
  insertNode, duplicateNode, deleteNode, newNodeId,
  edgeKey, slotOf, summarizeChanges, History, type Result,
} from '../src/app/ksd/graph-model.ts';
import { toScreen, toWorld, fitViewport, zoomAt, setFlipY, nodeAt, boxAt, linkPath } from '../src/app/ksd/graph-geometry.ts';
import { compactDuration, nodeSubtitle, channelOf, readDurations, formatDuration, parseDuration, typeColor, typeName, typeInfo, slotLabel, NODE_TYPES, CATEGORY_COLORS, MAX_NODES_PER_GRAPH, INSERTABLE_TYPES, defaultNodeSettings } from '../src/app/ksd/sparkworks-types.ts';
import { gateShape, nodeLayout, BASE_RADIUS, BOX_W, BOX_H, PORT_R, GATE_SCALE } from '../src/app/ksd/node-shapes.ts';

// NOTE: written against the ORIGINAL world0.ksd (it relies on facts such as "graph 3 has 199 nodes").
// For other saves use tests/core.check.ts and tests/gamefiles.check.ts.
const path = process.argv[2];
if (!path) { console.error('usage: tsx tests/model.check.ts <path to world0.ksd>'); process.exit(2); }
const parsed = parseKsd(new Uint8Array(readFileSync(path)));
const L0 = parsed.logic;
let failures = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
const data = <T>(r: Result<T>): T => { if (!r.ok) throw new Error('expected ok but got: ' + r.reason); return r.data; };
const reason = <T>(r: Result<T>): string => (r.ok ? '' : r.reason);
const ofType = (g: SparkGraph, t: number): SparkNode[] => g.nodes.filter((n) => n.type === t);
const noEdge = (g: SparkGraph, a: SparkNode, b: SparkNode, flag = 0) => !g.edges.some((e) => e.from === a.id && e.to === b.id && e.flag === flag);

// ================= node type knowledge
check('all 17 documented types are known', Object.keys(NODE_TYPES).length === 17 && typeName(0) === 'World Object' && typeName(16) === 'Global Reset');
check('category colours: gray/pink/blue/purple', typeColor(0) === CATEGORY_COLORS.world && typeColor(1) === typeColor(10) && typeColor(3) === typeColor(6) && typeColor(8) === typeColor(16) && new Set([0, 1, 3, 8].map(typeColor)).size === 4);
check('unknown type is handled', typeName(99) === 'Unknown type 99' && typeInfo(99).inputs === 'many');
check('slot labels', slotLabel(8, 0) === 'Upper' && slotLabel(8, 1) === 'Lower' && slotLabel(3, 0) === 'Input');

// ================= real data vs the game's rules
check('the real file has NO rule problems in any of its 10 graphs', L0.graphs.every((g) => validateGraph(g).length === 0), String(L0.graphs.map((g) => validateGraph(g).length)));

// ================= channels
const ch0 = (g: SparkGraph, t: number) => g.nodes.filter((n) => n.type === t).map((n) => channelOf(n)!).sort((a, b) => a - b);
check('graph 0 channels: Saves 1,2; Uses reuse them (1,1,1,2)', JSON.stringify(ch0(L0.graphs[0], 11)) === '[1,2]' && JSON.stringify(ch0(L0.graphs[0], 12)) === '[1,1,1,2]');
check('every graph: Save channels unique, every Use has a matching Save', L0.graphs.every((g) => {
  const s = ch0(g, 11); const u = ch0(g, 12);
  return new Set(s).size === s.length && u.every((c) => s.includes(c));
}));
check('channels all within 1..32', L0.graphs.every((g) => [...ch0(g, 11), ...ch0(g, 12)].every((c) => c >= 1 && c <= 32)));

// ================= durations
const hold1 = ofType(L0.graphs[1], 1)[0];
check('Hold in graph 1 reads 5:0:000', readDurations(hold1)[0].text === '5:0:000' && readDurations(hold1)[0].ms === 300000, readDurations(hold1)[0].text);
const tt0 = ofType(L0.graphs[0], 10)[0];
const ttd = readDurations(tt0);
check('Timed Trigger has delay then interval (0:0:000, 0:5:000)', ttd.length === 2 && ttd[0].field === 'delay' && ttd[0].text === '0:0:000' && ttd[1].field === 'interval' && ttd[1].text === '0:5:000');
const clk = ofType(L0.graphs[4], 2)[0];
check('Clock reads its interval (0.5 s)', readDurations(clk)[0].field === 'interval' && readDurations(clk)[0].ms === 500);
check('all stored times are whole ms within 10:0:000', L0.graphs.every((g) => g.nodes.every((n) => readDurations(n).every((d) => d.ms >= 0 && d.ms <= 600000))));
check('formatDuration', formatDuration(0) === '0:0:000' && formatDuration(5000) === '0:5:000' && formatDuration(65250) === '1:5:250' && formatDuration(600000) === '10:0:000');
check('parseDuration', parseDuration('0:5:000') === 5000 && parseDuration('10:0:000') === 600000 && parseDuration('1.5') === 1500 && parseDuration(' 2 ') === 2000 && parseDuration('abc') === null && parseDuration('1:2') === null && parseDuration('') === null && parseDuration('-3') === null);

// ================= moving
const g0 = L0.graphs[0];
const [n0] = g0.nodes;
const moved = moveNode(L0, 0, n0.id, n0.x + 10, n0.y + 5);
check('moveNode is immutable and shares untouched graphs', moved !== L0 && moved.graphs[1] === L0.graphs[1] && L0.graphs[0].nodes[0].x === n0.x);
check('moveNode no-op / unknown id returns same object', moveNode(L0, 0, n0.id, n0.x, n0.y) === L0 && moveNode(L0, 0, 'deadbeef', 1, 1) === L0);

// ================= connection rules (using real nodes from the file)
const G = L0.graphs[2]; const gi = 2;
const and = ofType(G, 3)[0], or = ofType(G, 4)[0], not = ofType(G, 5)[0], obj = ofType(G, 0)[0];
const save = ofType(G, 11)[0], use = ofType(G, 12)[0], on = ofType(G, 13)[0], dff = ofType(G, 8)[0], tt = ofType(G, 10)[0], hold = ofType(G, 1)[0];
const free = (target: SparkNode, srcs: SparkNode[], slot = 0) => srcs.find((s) => s.id !== target.id && canAddEdge(G, s.id, target.id, slot << 8, false));

check('refuses: node into itself', reason(addEdge(L0, gi, and.id, and.id, 0)) === 'A node cannot connect to itself.');
check('refuses: exact duplicate', reason(addEdge(L0, gi, G.edges[0].from, G.edges[0].to, G.edges[0].flag)).includes('already exists'));
check('refuses: input into Use Signal', reason(addEdge(L0, gi, and.id, use.id, 0)) === 'Use Signal accepts no inputs.');
check('refuses: input into On', reason(addEdge(L0, gi, and.id, on.id, 0)) === 'On accepts no inputs.');
check('refuses: output from Save Signal', reason(addEdge(L0, gi, save.id, and.id, 0)) === 'Save Signal has no outputs.');
const andSrc = free(and, [or, obj, not]) ?? obj;
check('refuses: LOWER connection on an AND', reason(addEdge(L0, gi, andSrc.id, and.id, 256)) === 'AND has only one input connection.');
const notWithInput = G.nodes.find((n) => n.type === 5 && G.edges.some((e) => e.to === n.id))!;
const srcForNot = G.nodes.find((n) => n.type === 3 && noEdge(G, n, notWithInput))!;
check('refuses: second input into a NOT', reason(addEdge(L0, gi, srcForNot.id, notWithInput.id, 0)) === 'NOT can only accept one input.');
const holdWithInput = G.nodes.find((n) => n.type === 1 && G.edges.some((e) => e.to === n.id));
if (holdWithInput) check('refuses: second input into a Hold', !addEdge(L0, gi, srcForNot.id, holdWithInput.id, 0).ok);
const dffFull = G.nodes.find((n) => n.type === 8 && G.edges.some((e) => e.to === n.id && slotOf(e.flag) === 0) && G.edges.some((e) => e.to === n.id && slotOf(e.flag) === 1))!;
check('refuses: D Flip-Flop UPPER already used', reason(addEdge(L0, gi, srcForNot.id, dffFull.id, 0)) === 'D Flip-Flop already has a signal on its UPPER connection.');
check('refuses: D Flip-Flop LOWER already used', reason(addEdge(L0, gi, srcForNot.id, dffFull.id, 256)) === 'D Flip-Flop already has a signal on its LOWER connection.');
check('refuses: slot 2', !addEdge(L0, gi, srcForNot.id, dffFull.id, 512).ok);
// same-channel Use -> Save (a Save normally already has its one input, so free it first)
const pair = (() => { for (const u of ofType(G, 12)) for (const s of ofType(G, 11)) if (channelOf(u) === channelOf(s) && noEdge(G, u, s)) return [u, s]; return null; })()!;
check('refuses a second input into a Save Signal (it is already connected)', reason(addEdge(L0, gi, pair[0].id, pair[1].id, 0)) === 'Save Signal can only accept one input.');
const saveInput = G.edges.find((e) => e.to === pair[1].id)!;
const freed = removeEdge(L0, gi, edgeKey(saveInput))!;
check('refuses: Use Signal -> Save Signal of the same channel', reason(addEdge(freed, gi, pair[0].id, pair[1].id, 0)) === 'A Use Signal cannot connect to a Save Signal of the same channel.');
check('same pair is allowed with rules switched off', addEdge(freed, gi, pair[0].id, pair[1].id, 0, false).ok);
const diffSave = ofType(G, 11).find((s) => channelOf(s) !== channelOf(pair[0]))!;
const freedDiff = removeEdge(L0, gi, edgeKey(G.edges.find((e) => e.to === diffSave.id)!))!;
check('allows: Use Signal -> Save Signal of a different channel', addEdge(freedDiff, gi, pair[0].id, diffSave.id, 0).ok);
check('rules off lets an input go into a Use Signal', addEdge(L0, gi, and.id, use.id, 0, false).ok);

// allowed edits
const andTarget = and; const okSrc = G.nodes.find((n) => n.type !== 11 && n.type !== 16 && n.id !== and.id && noEdge(G, n, and))!;
const added = data(addEdge(L0, gi, okSrc.id, andTarget.id, 0));
check('AND accepts any number of inputs', added.graphs[gi].edges.length === G.edges.length + 1);
check('graph stays rule-clean after a valid add', validateGraph(added.graphs[gi]).length === 0);
check('validateGraph reports a forced rule break', validateGraph(data(addEdge(L0, gi, and.id, use.id, 0, false)).graphs[gi]).some((p) => /accepts no inputs/.test(p.message)));

// autoSlot
const ttFreeBoth = G.nodes.find((n) => n.type === 10 && !G.edges.some((e) => e.to === n.id));
check('autoSlot: AND/Use etc. always 0', autoSlot(G, and.id) === 0 && autoSlot(G, not.id) === 0);
check('autoSlot: full two-input node returns LOWER (1)', autoSlot(G, dffFull.id) === 1);
if (ttFreeBoth) check('autoSlot: empty two-input node returns UPPER (0)', autoSlot(G, ttFreeBoth.id) === 0);
const dffOnlyUpper = G.nodes.find((n) => n.type === 8 && !G.edges.some((e) => e.to === n.id && slotOf(e.flag) === 1) && G.edges.some((e) => e.to === n.id && slotOf(e.flag) === 0));
if (dffOnlyUpper) check('autoSlot: upper taken, lower free -> 1', autoSlot(G, dffOnlyUpper.id) === 1);

// remove / reverse / slot
const key0 = edgeKey(G.edges[0]);
const without = removeEdge(L0, gi, key0)!;
check('removeEdge removes exactly that edge; unknown key -> null', without.graphs[gi].edges.length === G.edges.length - 1 && removeEdge(L0, gi, 'nope') === null);
// reversing an AND->NOT style link: pick an edge between two node types that can both send and receive
const revCand = G.edges.find((e) => { const a = G.nodes.find((n) => n.id === e.from)!; const b = G.nodes.find((n) => n.id === e.to)!; return typeInfo(a.type).inputs === 'many' && typeInfo(b.type).outputs && typeInfo(b.type).inputs === 'many' && slotOf(e.flag) === 0; });
if (revCand) {
  const r = data(reverseEdge(L0, gi, edgeKey(revCand)));
  check('reverseEdge swaps endpoints and keeps the count', r.graphs[gi].edges.length === G.edges.length && r.graphs[gi].edges.some((e) => e.from === revCand.to && e.to === revCand.from));
}
const intoUse = G.edges.find((e) => G.nodes.find((n) => n.id === e.from)!.type === 12)!; // a Use Signal feeding something
check('reverse refused when it would feed a Use Signal', reason(reverseEdge(L0, gi, edgeKey(intoUse))) === 'Use Signal accepts no inputs.');
check('...but allowed with rules off', reverseEdge(L0, gi, edgeKey(intoUse), false).ok);
const lowerEdge = G.edges.find((e) => slotOf(e.flag) === 1)!;
check('switching a LOWER link to UPPER is refused when UPPER is taken', reason(setEdgeSlot(L0, gi, edgeKey(lowerEdge), 0)).includes('already has a signal on its UPPER'));
check('switching into an AND is refused (single input)', (() => { const e = G.edges.find((x) => G.nodes.find((n) => n.id === x.to)!.type === 3 && slotOf(x.flag) === 0)!; return reason(setEdgeSlot(L0, gi, edgeKey(e), 1)).includes('only one input'); })());

// channels
const saveA = ofType(G, 11)[0];
const usedCh = new Set(ofType(G, 11).map((n) => channelOf(n)!));
const freeCh = [...Array(32).keys()].map((i) => i + 1).find((c) => !usedCh.has(c))!;
const dupCh = [...usedCh].find((c) => c !== channelOf(saveA))!;
check('setChannel: refuses a channel another Save already uses', reason(setChannel(L0, gi, saveA.id, dupCh)).includes('already uses channel'));
check('...allowed with rules off', setChannel(L0, gi, saveA.id, dupCh, false).ok);
const ch2 = data(setChannel(L0, gi, saveA.id, freeCh));
check('setChannel changes the stored byte (channel - 1)', channelOf(ch2.graphs[gi].nodes.find((n) => n.id === saveA.id)!) === freeCh && ch2.graphs[gi].nodes.find((n) => n.id === saveA.id)!.extra === (freeCh - 1).toString(16).padStart(2, '0'));
check('setChannel: out-of-range / non-integer refused', !setChannel(L0, gi, saveA.id, 0).ok && !setChannel(L0, gi, saveA.id, 33).ok && !setChannel(L0, gi, saveA.id, 2.5).ok);
check('setChannel: node without a channel refused', !setChannel(L0, gi, and.id, 3).ok);
check('setChannel: same value is a no-op', setChannel(L0, gi, saveA.id, channelOf(saveA)!).ok && data(setChannel(L0, gi, saveA.id, channelOf(saveA)!)) === L0);
// a Use that feeds a Save of another channel: changing it to that channel is refused
const link = G.edges.find((e) => G.nodes.find((n) => n.id === e.from)!.type === 12 && G.nodes.find((n) => n.id === e.to)!.type === 11);
if (link) {
  const u = G.nodes.find((n) => n.id === link.from)!; const s = G.nodes.find((n) => n.id === link.to)!;
  check('setChannel: refused if it would make a Use feed a Save on the same channel', reason(setChannel(L0, gi, u.id, channelOf(s)!)).includes('same channel'));
}

// durations
const ttG = ofType(L0.graphs[0], 10)[0];
const d1 = data(setDuration(L0, 0, ttG.id, 'delay', 1500));
check('setDuration writes the first value for Delay', readDurations(d1.graphs[0].nodes.find((n) => n.id === ttG.id)!)[0].ms === 1500 && readDurations(d1.graphs[0].nodes.find((n) => n.id === ttG.id)!)[1].ms === 5000);
const d2 = data(setDuration(d1, 0, ttG.id, 'interval', 600000));
check('setDuration writes the second value for Interval (max 10:0:000)', readDurations(d2.graphs[0].nodes.find((n) => n.id === ttG.id)!)[1].ms === 600000);
check('setDuration: > 10 min, negative, fractional refused', !setDuration(L0, 0, ttG.id, 'delay', 600001).ok && !setDuration(L0, 0, ttG.id, 'delay', -1).ok && !setDuration(L0, 0, ttG.id, 'delay', 1.5).ok);
check('setDuration: Hold has no interval; AND has none', !setDuration(L0, 1, hold1.id, 'interval', 1000).ok && !setDuration(L0, gi, and.id, 'delay', 1000).ok);
check('setDuration: unchanged value is a no-op', data(setDuration(L0, 0, ttG.id, 'interval', 5000)) === L0);

// ================= change summary
check('summary of identical = 0', summarizeChanges(L0, L0).total === 0);
check('move then move back = 0 changes', summarizeChanges(L0, moveNode(moved, 0, n0.id, n0.x, n0.y)).total === 0);
check('1 moved node counted', summarizeChanges(L0, moved).movedNodes === 1);
const sAdd = summarizeChanges(L0, added);
check('1 added edge counted', sAdd.addedEdges === 1 && sAdd.removedEdges === 0 && sAdd.perGraph[gi].addedEdges === 1);
check('remove counted', summarizeChanges(L0, without).removedEdges === 1);
const sEdit = summarizeChanges(L0, d2);
check('edited node settings counted separately from moves', sEdit.editedNodes === 1 && sEdit.movedNodes === 0 && sEdit.total === 1);


// ================= node shapes
check('gate symbols exist for AND, OR, NOT, NAND, XOR only', [3, 4, 5, 6, 7].every((t) => gateShape(t) !== null) && [0, 1, 2, 8, 9, 10, 11, 12, 13, 14, 15, 16].every((t) => gateShape(t) === null));
check('only NOT and NAND have an inversion circle; only XOR has the extra curve', [5, 6].every((t) => gateShape(t)!.bubbleCx !== undefined) && [3, 4, 7].every((t) => gateShape(t)!.bubbleCx === undefined) && gateShape(7)!.extra !== undefined && [3, 4, 5, 6].every((t) => gateShape(t)!.extra === undefined));
const coords = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
check('every gate path is well formed and stays within ~the node radius', [3, 4, 5, 6, 7].every((t) => { const g = gateShape(t)!; const ok = /^M/.test(g.body) && /Z$/.test(g.body) && !/NaN/.test(g.body); const xs = coords(g.body); return ok && xs.every((v) => Math.abs(v) <= BASE_RADIUS + 0.5); }));
check('inversion circle sits inside the node radius', [5, 6].every((t) => gateShape(t)!.bubbleCx! + 4.5 <= BASE_RADIUS));

// ================= defaults for new nodes
check('defaults: gates, World Object and the rest have no extra data (as the game writes them)', [0, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16].every((t) => { const d = defaultNodeSettings(t); return d.hasExtra === 0 && d.extra === ''; }));
check('defaults: Hold/Clock/Timed Trigger carry 8/8/16 bytes of times', defaultNodeSettings(1).extra.length === 16 && defaultNodeSettings(2).extra.length === 16 && defaultNodeSettings(10).extra.length === 32 && [1, 2, 10].every((t) => defaultNodeSettings(t).hasExtra === 1));
check('defaults: Save/Use carry a 1-byte channel', defaultNodeSettings(11, 5).extra === '04' && defaultNodeSettings(12).extra === '00');
const dflt = (t: number) => readDurations({ id: 'x', x: 0, y: 0, type: t, hasExtra: 1, extra: defaultNodeSettings(t).extra }).map((d) => `${d.field}=${d.ms}`).join(',');
check('defaults match the values the game gives a new node: Hold 0.5 s, Clock 0.5 s, Timed Trigger delay 1 s / interval 0', dflt(1) === 'delay=500' && dflt(2) === 'interval=500' && dflt(10) === 'delay=1000,interval=0', `${dflt(1)} | ${dflt(2)} | ${dflt(10)}`);
check('defaults: times are valid (0..10:0:000)', [1, 2, 10].every((t) => readDurations({ id: 'x', x: 0, y: 0, type: t, hasExtra: 1, extra: defaultNodeSettings(t).extra }).every((d) => d.ms >= 0 && d.ms <= 600000)));
check('INSERTABLE_TYPES covers all 17 types, World Object included', INSERTABLE_TYPES.length === 17 && INSERTABLE_TYPES.includes(0));

// ================= inserting nodes
const seq = (...nums: number[]) => { let i = 0; return () => nums[i++ % nums.length]; };
const allIds = new Set(L0.graphs.flatMap((g) => g.nodes.map((n) => n.id)));
const ins0 = data(insertNode(L0, 4, { type: 3, x: 100.5, y: 200.5 }));
const newNode = ins0.data.graphs[4].nodes.at(-1)!;
check('insertNode appends a node at the requested position', ins0.data.graphs[4].nodes.length === L0.graphs[4].nodes.length + 1 && newNode.id === ins0.id && newNode.x === 100.5 && newNode.y === 200.5 && newNode.type === 3);
check('new id is 4 bytes of hex and unique across the whole file', /^[0-9a-f]{8}$/.test(ins0.id) && !allIds.has(ins0.id));
check('insertNode does not touch other graphs or mutate the original', ins0.data.graphs[3] === L0.graphs[3] && L0.graphs[4].nodes.length === 26);
const rigged = seq(L0.graphs[0].nodes[0].id.slice(0, 2) ? parseInt(L0.graphs[0].nodes[0].id.slice(0, 2), 16) / 256 : 0.1, parseInt(L0.graphs[0].nodes[0].id.slice(2, 4), 16) / 256, parseInt(L0.graphs[0].nodes[0].id.slice(4, 6), 16) / 256, parseInt(L0.graphs[0].nodes[0].id.slice(6, 8), 16) / 256, 0.5, 0.25, 0.75, 0.125);
const clash = newNodeId(L0, rigged);
check('newNodeId skips an id that is already used (anywhere in the file)', !allIds.has(clash) && clash !== L0.graphs[0].nodes[0].id && clash === '8040c020', clash);
check('every insertable type can be inserted and round-trips', INSERTABLE_TYPES.every((t) => { const r = insertNode(L0, 5, { type: t, x: 1, y: 2 }); if (!r.ok) return false; const b = parseKsd(buildKsd(parsed, r.data.data)); return logicEquals(b.logic, r.data.data); }));
const woIns = data(insertNode(L0, 4, { type: 0, x: 0, y: 0 }));
const wo = woIns.data.graphs[4].nodes.find((n) => n.id === woIns.id)!;
check('a World Object can be inserted with no object assigned (hasExtra 0, as the game writes it)', wo.type === 0 && wo.hasExtra === 0 && wo.extra === '');
check('unknown type refused', !insertNode(L0, 4, { type: 99, x: 0, y: 0 }).ok);
// channels
const g2save = ofType(L0.graphs[2], 11).map((n) => channelOf(n)!);
const lowestFree = [...Array(32).keys()].map((i) => i + 1).find((c) => !g2save.includes(c))!;
const sv = data(insertNode(L0, 2, { type: 11, x: 0, y: 0 }));
check('new Save Signal gets the lowest free channel', channelOf(sv.data.graphs[2].nodes.find((n) => n.id === sv.id)!) === lowestFree, `ch ${lowestFree}`);
check('graph stays free of rule problems after adding a Save Signal', validateGraph(sv.data.graphs[2]).length === 0);
const us = data(insertNode(L0, 2, { type: 12, x: 0, y: 0 }));
check('new Use Signal starts on the lowest channel that has a Save', channelOf(us.data.graphs[2].nodes.find((n) => n.id === us.id)!) === Math.min(...g2save));
// fill all 32 save channels in graph 5 to test the exhaustion rule
let full = L0;
for (let i = 0; i < 40; i++) { const r = insertNode(full, 5, { type: 11, x: i, y: i }); if (!r.ok) break; full = r.data.data; }
check('Save channels run out after 32 (rules on)', ofType(full.graphs[5], 11).length === 32 && reason(insertNode(full, 5, { type: 11, x: 0, y: 0 })).includes('All 32'));
check('...unless rules are off (then channel 1 is reused)', insertNode(full, 5, { type: 11, x: 0, y: 0 }, false).ok);

// ================= the 200-node limit (graph 3 starts at 199)
check('graph 3 starts at 199 nodes', L0.graphs[3].nodes.length === 199 && MAX_NODES_PER_GRAPH === 200);
const to200 = data(insertNode(L0, 3, { type: 4, x: 0, y: 0 }));
check('the 200th node is allowed', to200.data.graphs[3].nodes.length === 200 && validateGraph(to200.data.graphs[3]).length === 0);
check('the 201st node is refused', reason(insertNode(to200.data, 3, { type: 4, x: 0, y: 0 })) === 'This graph already has 200 nodes, the most Enshrouded allows.');
check('the limit cannot be switched off with the rules toggle', !insertNode(to200.data, 3, { type: 4, x: 0, y: 0 }, false).ok);
check('duplicating at the limit is refused too', !duplicateNode(to200.data, 3, to200.data.graphs[3].nodes[1].id).ok);
check('a full 200-node graph still builds and re-parses exactly', logicEquals(parseKsd(buildKsd(parsed, to200.data)).logic, to200.data));
check('deleting one frees a slot', insertNode(data({ ok: true as const, data: deleteNode(to200.data, 3, to200.data.graphs[3].nodes[0].id)!.data }), 3, { type: 4, x: 0, y: 0 }).ok);
check('a graph over the limit is reported by validateGraph', validateGraph({ ...L0.graphs[3], nodes: [...L0.graphs[3].nodes, ...L0.graphs[3].nodes.slice(0, 2).map((n, i) => ({ ...n, id: 'ffffff0' + i }))] }).some((p) => /at most 200/.test(p.message)));

// ================= duplicating
const andDup = ofType(L0.graphs[2], 3)[0];
const dupA = data(duplicateNode(L0, 2, andDup.id));
const dn = dupA.data.graphs[2].nodes.find((n) => n.id === dupA.id)!;
check('duplicate copies type, offsets position, new id, no links', dn.type === 3 && dn.x === andDup.x + 60 && dn.y === andDup.y + 60 && !dupA.data.graphs[2].edges.some((e) => e.from === dupA.id || e.to === dupA.id) && dupA.id !== andDup.id);
const ttDup = ofType(L0.graphs[0], 10)[0];
const dupB = data(duplicateNode(L0, 0, ttDup.id));
check('duplicate copies time settings', dupB.data.graphs[0].nodes.find((n) => n.id === dupB.id)!.extra === ttDup.extra);
const saveDup = ofType(L0.graphs[2], 11)[0];
const dupC = data(duplicateNode(L0, 2, saveDup.id));
check('duplicating a Save Signal picks a new free channel (they must be unique)', channelOf(dupC.data.graphs[2].nodes.find((n) => n.id === dupC.id)!) === lowestFree && validateGraph(dupC.data.graphs[2]).length === 0);
const useDup = ofType(L0.graphs[2], 12)[0];
check('duplicating a Use Signal keeps its channel', channelOf(data(duplicateNode(L0, 2, useDup.id)).data.graphs[2].nodes.at(-1)!) === channelOf(useDup));
const woDup = data(duplicateNode(L0, 2, ofType(L0.graphs[2], 0)[0].id));
const woCopy = woDup.data.graphs[2].nodes.find((n) => n.id === woDup.id)!;
check('duplicating a World Object gives an unassigned one (an object is never referenced twice in a graph)', woCopy.type === 0 && woCopy.hasExtra === 0 && woCopy.extra === '' && !L0.graphs[2].nodes.some((n) => n.type === 0 && n.extra === woCopy.extra && n.extra !== ''));
check('...and it round-trips through build + parse', logicEquals(parseKsd(buildKsd(parsed, woDup.data)).logic, woDup.data));
check('unknown node id refused', !duplicateNode(L0, 2, 'deadbeef').ok);

// ================= deleting
const victim = G.nodes.find((n) => n.type === 3 && G.edges.filter((e) => e.from === n.id || e.to === n.id).length >= 2)!;
const touching = G.edges.filter((e) => e.from === victim.id || e.to === victim.id).length;
const del = deleteNode(L0, 2, victim.id)!;
const idxVictim = G.nodes.findIndex((n) => n.id === victim.id);
check('deleteNode puts the last node into the freed slot (as the game does) and keeps the rest in order', (() => { const after = deleteNode(L0, 2, victim.id)!.data.graphs[2].nodes; return after.length === G.nodes.length - 1 && after[idxVictim].id === G.nodes.at(-1)!.id && after.every((n, i) => i === idxVictim || n.id === G.nodes[i].id); })());
const lastNode = G.nodes.at(-1)!;
check('deleting the last node simply removes it', (() => { const after = deleteNode(L0, 2, lastNode.id)!.data.graphs[2].nodes; return after.length === G.nodes.length - 1 && after.every((n, i) => n.id === G.nodes[i].id); })());
check('deleteNode removes the node and every link touching it', del.data.graphs[2].nodes.length === G.nodes.length - 1 && del.removedEdges === touching && del.data.graphs[2].edges.length === G.edges.length - touching && !del.data.graphs[2].edges.some((e) => e.from === victim.id || e.to === victim.id));
check('...and the graph still has no dangling links', del.data.graphs[2].edges.every((e) => del.data.graphs[2].nodes.some((n) => n.id === e.from) && del.data.graphs[2].nodes.some((n) => n.id === e.to)));
check('...without touching other graphs', del.data.graphs[3] === L0.graphs[3]);
check('deleting an unknown node returns null', deleteNode(L0, 2, 'deadbeef') === null);
const g0save = ofType(L0.graphs[0], 11)[0];
const delSave = deleteNode(L0, 0, g0save.id)!;
const usesOnCh = ofType(L0.graphs[0], 12).filter((n) => channelOf(n) === channelOf(g0save)).length;
check('deleting a Save Signal reports the Use Signals left without one', delSave.orphanedUses === usesOnCh && usesOnCh > 0, `${delSave.orphanedUses} orphaned`);
check('deleting a non-Save reports none', del.orphanedUses === 0);
const cleanThrough = data({ ok: true as const, data: deleteNode(L0, 2, victim.id)!.data });
check('delete + build + re-parse round-trips exactly', logicEquals(parseKsd(buildKsd(parsed, cleanThrough)).logic, cleanThrough));
check('deleting every node of a graph is representable', (() => { let l = L0; for (const n of [...L0.graphs[5].nodes]) l = deleteNode(l, 5, n.id)!.data; return l.graphs[5].nodes.length === 0 && l.graphs[5].edges.length === 0 && logicEquals(parseKsd(buildKsd(parsed, l)).logic, l); })());

// ================= summary counts nodes
const sAdd2 = summarizeChanges(L0, ins0.data);
check('summary: 1 added node, nothing else', sAdd2.addedNodes === 1 && sAdd2.total === 1 && sAdd2.perGraph[4].addedNodes === 1);
const sDel = summarizeChanges(L0, del.data);
check('summary: deleted node and its links are counted', sDel.removedNodes === 1 && sDel.removedEdges === touching && sDel.addedNodes === 0);
check('summary: an added then removed node nets to zero changes', summarizeChanges(L0, deleteNode(ins0.data, 4, ins0.id)!.data).total === 0 || summarizeChanges(L0, deleteNode(ins0.data, 4, ins0.id)!.data).addedNodes === 0);
check('summary: moved counts only nodes that exist in both', summarizeChanges(L0, moveNode(ins0.data, 4, ins0.id, 5, 5)).movedNodes === 0 && summarizeChanges(L0, moveNode(ins0.data, 4, ins0.id, 5, 5)).addedNodes === 1);

// ================= history
const h = new History(L0);
h.push(moved); h.push(added); h.push(added);
check('push of same object ignored; undo walks back', h.canUndo && h.undo() === moved && h.undo() === L0 && !h.canUndo);
check('redo walks forward', h.redo() === moved && h.redo() === added && !h.canRedo);
h.undo(); h.push(without);
check('push clears redo', !h.canRedo && h.current === without);

// ================= geometry
for (const flip of [false, true]) {
  const v = { scale: 0.37, tx: 120, ty: -40, flipY: flip };
  const p = toScreen(v, 4321.5, 1234.25); const w = toWorld(v, p.x, p.y);
  check(`toWorld(toScreen(p)) == p (flipY=${flip})`, near(w.x, 4321.5) && near(w.y, 1234.25));
}
const pts = L0.graphs[2].nodes.map((n) => ({ x: n.x, y: n.y }));
for (const flip of [false, true]) {
  const v = fitViewport(pts, 900, 600, flip, 60);
  check(`fit keeps all 182 nodes inside the view (flipY=${flip})`, pts.map((p) => toScreen(v, p.x, p.y)).every((p) => p.x >= 59 && p.x <= 841 && p.y >= 59 && p.y <= 541));
}
const v0 = { scale: 0.5, tx: 10, ty: 20, flipY: false };
const wB = toWorld(v0, 300, 200); const wA = toWorld(zoomAt(v0, 300, 200, 1.7), 300, 200);
check('zoomAt keeps the point under the cursor fixed', near(wB.x, wA.x) && near(wB.y, wA.y));
const vf = setFlipY(v0, true, 300);
const wp = toWorld(v0, 100, 300);
check('setFlipY keeps the screen centre fixed', near(toScreen(vf, wp.x, wp.y).y, 300));
check('nodeAt nearest within radius', nodeAt([{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 20, y: 10 }], 18, 11, 6) === 'b' && nodeAt([{ id: 'a', x: 10, y: 10 }], 100, 100, 6) === null);
check('boxAt: inside the box wins, nearest centre breaks ties, margin extends it', boxAt([{ id: 'a', x: 100, y: 100, halfW: 50, halfH: 20 }, { id: 'b', x: 160, y: 100, halfW: 50, halfH: 20 }], 140, 100) === 'b' && boxAt([{ id: 'a', x: 100, y: 100, halfW: 50, halfH: 20 }], 100, 125) === null && boxAt([{ id: 'a', x: 100, y: 100, halfW: 50, halfH: 20 }], 100, 125, 6) === 'a');
const lp = linkPath(0, 0, 200, 100);
check('linkPath leaves the output rightwards and enters the input from the left', lp.d.startsWith('M0 0C') && lp.d.endsWith('200 100') && !/NaN/.test(lp.d) && lp.mx > 0 && lp.mx < 200);
const lpBack = linkPath(300, 0, 0, 0);
check('linkPath handles a link that runs backwards without NaN', !/NaN/.test(lpBack.d) && lpBack.d.startsWith('M300 0C'));

// ================= node layout: boxes, slots (ports)
const L17 = Array.from({ length: 17 }, (_, t) => nodeLayout(t));
check('only the five logic gates use gate symbols; everything else is a rectangle', L17.every((l, t) => l.kind === ([3, 4, 5, 6, 7].includes(t) ? 'gate' : 'box')));
const inCount = (t: number) => nodeLayout(t).inputs.length;
check('Save Signal: one input slot on the left, no output', inCount(11) === 1 && nodeLayout(11).output === null && nodeLayout(11).inputs[0].x < 0);
check('Timed Trigger: two input slots (upper above lower) on the left and one output on the right', (() => { const l = nodeLayout(10); return l.inputs.length === 2 && l.inputs[0].slot === 0 && l.inputs[1].slot === 1 && l.inputs[0].y < l.inputs[1].y && l.inputs.every((p) => p.x < 0) && l.output !== null && l.output.x > 0; })());
check('D Flip-Flop and Toggle also have two input slots', inCount(8) === 2 && inCount(9) === 2);
check('Use Signal, On and Off have no input slots but do have an output', [12, 13, 14].every((t) => inCount(t) === 0 && nodeLayout(t).output !== null));
check('Global Reset: one input, no output', inCount(16) === 1 && nodeLayout(16).output === null);
check('single-input nodes (Hold, Clock, NOT, Flank) and many-input nodes (AND, OR, NAND, XOR, World Object) show one input slot', [1, 2, 5, 15, 3, 4, 6, 7, 0].every((t) => inCount(t) === 1));
check('every node that can send has an output slot on its right', L17.every((l, t) => (typeInfo(t).outputs ? l.output !== null && l.output.x > 0 : l.output === null)));
check('slot counts follow the game\'s input rules for every type', L17.every((l, t) => l.inputs.length === ({ none: 0, many: 1, single: 1, upperLower: 2 } as const)[typeInfo(t).inputs]));
check('slots sit on the node edge (boxes) / on the symbol (gates) and stay within the clickable area', L17.every((l) => [...l.inputs, ...(l.output ? [l.output] : [])].every((p) => Math.abs(p.x) <= l.halfW + 1 && Math.abs(p.y) <= l.halfH + 1)));
check('slots do not overlap: upper and lower are further apart than two slot radii', nodeLayout(10).inputs[1].y - nodeLayout(10).inputs[0].y > 2 * PORT_R);
check('boxes are larger than the old 48 px circles; gates are drawn larger too', BOX_W > 48 && BOX_H > 48 && GATE_SCALE > 1);
const gAll = [3, 4, 5, 6, 7].map((t) => gateShape(t)!);
check('gate input/output slots: input left of output, near the symbol; NOT/NAND output sits clear of the inversion circle', gAll.every((g) => g.inX < g.outX && Math.abs(g.inX) <= BASE_RADIUS + 3 && Math.abs(g.outX) <= BASE_RADIUS + 6) && [5, 6].every((t) => { const g = gateShape(t)!; return g.outX - PORT_R / GATE_SCALE >= g.bubbleCx! + 4.5 - 0.6; }));

// ================= short labels on node boxes
check('compactDuration', compactDuration(0) === '0s' && compactDuration(500) === '0.5s' && compactDuration(1000) === '1s' && compactDuration(59999) === '59.999s' && compactDuration(60000) === '1m' && compactDuration(65250) === '1m5.25s' && compactDuration(600000) === '10m');
const nodeOf = (t: number) => L0.graphs.flatMap((g) => g.nodes).find((n) => n.type === t)!;
check('node subtitles: channel for Save/Use, delay for Hold, interval for Clock, both for Timed Trigger', /^Channel \d+$/.test(nodeSubtitle(nodeOf(11))) && /^Channel \d+$/.test(nodeSubtitle(nodeOf(12))) && /^Delay /.test(nodeSubtitle(nodeOf(1))) && /^Interval /.test(nodeSubtitle(nodeOf(2))) && /^D .* I /.test(nodeSubtitle(nodeOf(10))), `${nodeSubtitle(nodeOf(10))}`);
check('node subtitles: nothing for gates; World Object shows its ref or "no object"', nodeSubtitle(nodeOf(3)) === '' && /^ref [0-9a-f]{8}$/.test(nodeSubtitle(nodeOf(0))) && nodeSubtitle({ id: 'x', x: 0, y: 0, type: 0, hasExtra: 0, extra: '' }) === 'no object');

// ================= full pipeline: many kinds of edit -> build -> re-parse -> equal
let cur = L0;
cur = moveNode(cur, 2, G.nodes[5].id, 4000.5, 1500.25);
cur = data(addEdge(cur, 2, okSrc.id, andTarget.id, 0));
cur = removeEdge(cur, 3, edgeKey(L0.graphs[3].edges[10]))!;
cur = data(setChannel(cur, 2, saveA.id, freeCh));
cur = data(setDuration(cur, 0, ttG.id, 'delay', 2500));
cur = data(setDuration(cur, 1, hold1.id, 'delay', 90000));
const out = buildKsd(parsed, cur);
const back = parseKsd(out);
check('mixed edits survive build + re-parse exactly', logicEquals(back.logic, cur));
const sum = summarizeChanges(L0, back.logic);
check('re-parsed file reports the same changes', sum.movedNodes === 1 && sum.editedNodes === 3 && sum.addedEdges === 1 && sum.removedEdges === 1, JSON.stringify({ m: sum.movedNodes, e: sum.editedNodes, a: sum.addedEdges, r: sum.removedEdges }));
check('graph names still resolve after export', back.logic.graphs.every((g, i) => parsed.customStrings.get(g.graphId.slice(10)) === [...parsed.customStrings.values()].find((v) => v === parsed.customStrings.get(L0.graphs[i].graphId.slice(10)))));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
