/**
 * Compares this editor's writer with saves the GAME itself wrote.
 *
 *   npx tsx tests/gamefiles.check.ts <base.ksd> <moved.ksd> <add.ksd> <delete.ksd>
 *
 * base    a game-written save
 * moved   the same save after the game moved some nodes
 * add     the same save after the game added one node (appended to a graph)
 * delete  the same save after the game deleted one node
 *
 * For each edit the editor's own operations are applied to `base`, then the logic chunk is
 * rebuilt and compared byte for byte with the game's (graph timestamps and the runtime-state
 * table are copied from the game's file, because the game owns those). The directory checksum the
 * editor computes must equal the one the game wrote.
 */
import { readFileSync } from 'node:fs';
import { parseKsd, serializeLogicPayload, buildKsd, bytesEqual, checksumMismatches, logicEquals, type LogicData, type ParsedKsd } from '../src/app/ksd/ksd-core.ts';
import { moveNode, deleteNode, insertNode, addEdge, validateGraph } from '../src/app/ksd/graph-model.ts';

const [pBase, pMoved, pAdd, pDel] = process.argv.slice(2);
if (!pDel) { console.error('usage: tsx tests/gamefiles.check.ts <base.ksd> <moved.ksd> <add.ksd> <delete.ksd>'); process.exit(2); }
const load = (f: string) => parseKsd(new Uint8Array(readFileSync(f)));
const base = load(pBase), moved = load(pMoved), add = load(pAdd), del = load(pDel);
let fails = 0;
const t = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails++; };
const withGameState = (L: LogicData, game: ParsedKsd): LogicData => ({ ...L, trailer: game.logic.trailer, graphs: L.graphs.map((g, i) => ({ ...g, timestampHex: game.logic.graphs[i].timestampHex })) });
const chunk = (p: ParsedKsd) => p.bytes.subarray(p.logicEntry.offset, p.logicEntry.offset + p.logicEntry.size);

for (const [n, p] of [['base', base], ['moved', moved], ['add', add], ['delete', del]] as const) {
  t(`${n}: every chunk checksum in the game's file equals low32(XXH3-64) of the chunk`, checksumMismatches(p).length === 0, `${p.entries.length} chunks`);
}

// ---- MOVE
let L: LogicData = base.logic;
let movedCount = 0;
base.logic.graphs.forEach((g, gi) => moved.logic.graphs[gi].nodes.forEach((n) => { const o = g.nodes.find((q) => q.id === n.id); if (o && (o.x !== n.x || o.y !== n.y)) { L = moveNode(L, gi, n.id, n.x, n.y); movedCount++; } }));
L = withGameState(L, moved);
let r = parseKsd(buildKsd(base, L));
t(`MOVE (${movedCount} nodes): serialized payload equals the game's`, bytesEqual(serializeLogicPayload(L), moved.logicPayload));
t('MOVE: recomputed checksum equals the one the game wrote', r.logicEntry.checksum === moved.logicEntry.checksum, r.logicEntry.checksum.toString(16));
t('MOVE: rebuilt logic chunk equals the game\'s byte for byte', bytesEqual(chunk(r), chunk(moved)));

// ---- ADD (the game appends the new node at the end of its graph's node list)
const gAdd = add.logic.graphs.findIndex((g, i) => g.nodes.length !== base.logic.graphs[i].nodes.length);
const gameNode = add.logic.graphs[gAdd].nodes.at(-1)!;
const ins = insertNode(base.logic, gAdd, { type: gameNode.type, x: gameNode.x, y: gameNode.y });
if (!ins.ok) throw new Error(ins.reason);
const mine = { ...ins.data.data, graphs: ins.data.data.graphs.map((g, i) => (i === gAdd ? { ...g, nodes: g.nodes.map((n) => (n.id === ins.data.id ? { ...n, id: gameNode.id } : n)) } : g)) };
L = withGameState(mine, add);
r = parseKsd(buildKsd(base, L));
t('ADD: a new node has the same hasExtra/extra the game gives it', ins.data.data.graphs[gAdd].nodes.at(-1)!.hasExtra === gameNode.hasExtra && ins.data.data.graphs[gAdd].nodes.at(-1)!.extra === gameNode.extra);
t('ADD: serialized payload equals the game\'s', bytesEqual(serializeLogicPayload(L), add.logicPayload));
t('ADD: recomputed checksum equals the one the game wrote', r.logicEntry.checksum === add.logicEntry.checksum, r.logicEntry.checksum.toString(16));
t('ADD: rebuilt logic chunk equals the game\'s byte for byte', bytesEqual(chunk(r), chunk(add)));

// ---- DELETE (the game moves the last node into the freed slot)
const gDel = del.logic.graphs.findIndex((g, i) => g.nodes.length !== base.logic.graphs[i].nodes.length);
const goneId = base.logic.graphs[gDel].nodes.find((n) => !del.logic.graphs[gDel].nodes.some((q) => q.id === n.id))!.id;
L = withGameState(deleteNode(base.logic, gDel, goneId)!.data, del);
r = parseKsd(buildKsd(base, L));
t('DELETE: serialized payload equals the game\'s (last node fills the freed slot)', bytesEqual(serializeLogicPayload(L), del.logicPayload));
t('DELETE: recomputed checksum equals the one the game wrote', r.logicEntry.checksum === del.logicEntry.checksum, r.logicEntry.checksum.toString(16));
t('DELETE: rebuilt logic chunk equals the game\'s byte for byte', bytesEqual(chunk(r), chunk(del)));

// ---- randomized stress: edit each game file, rebuild, and check every structural invariant
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
for (const [name, p] of [['base', base], ['moved', moved], ['add', add], ['delete', del]] as const) {
  let ok = true; let why = '';
  for (let round = 0; round < 25 && ok; round++) {
    let cur = p.logic;
    for (let k = 0; k < 6; k++) {
      const gi = Math.floor(rnd() * cur.graphs.length);
      const g = cur.graphs[gi];
      const pick = rnd();
      if (pick < 0.3 && g.nodes.length) { const n = g.nodes[Math.floor(rnd() * g.nodes.length)]; cur = moveNode(cur, gi, n.id, n.x + rnd() * 100, n.y + rnd() * 100); }
      else if (pick < 0.6) { const r2 = insertNode(cur, gi, { type: Math.floor(rnd() * 17), x: rnd() * 5000, y: rnd() * 3000 }); if (r2.ok) cur = r2.data.data; }
      else if (pick < 0.8 && g.nodes.length) { const d = deleteNode(cur, gi, g.nodes[Math.floor(rnd() * g.nodes.length)].id); if (d) cur = d.data; }
      else if (g.nodes.length > 2) { const a = g.nodes[Math.floor(rnd() * g.nodes.length)], b = g.nodes[Math.floor(rnd() * g.nodes.length)]; const e = addEdge(cur, gi, a.id, b.id, 0, false); if (e.ok) cur = e.data; }
    }
    const out = buildKsd(p, cur);
    const q = parseKsd(out);
    const e0 = p.entries, e1 = q.entries;
    const sorted = [...e1].sort((a, b) => a.offset - b.offset);
    const contiguous = sorted.every((e, i) => i === 0 || e.offset === sorted[i - 1].offset + sorted[i - 1].size);
    const others = e0.filter((e) => e.name !== 'logic').every((e) => { const f = e1.find((x) => x.name === e.name)!; return f.size === e.size && f.checksum === e.checksum && bytesEqual(p.bytes.subarray(e.offset, e.offset + e.size), out.subarray(f.offset, f.offset + f.size)); });
    const checks = checksumMismatches(q).length === 0 && q.container.fileSize === out.length && logicEquals(q.logic, cur);
    const startSame = sorted[0].offset === [...e0].sort((a, b) => a.offset - b.offset)[0].offset;
    if (!(contiguous && others && checks && startSame)) { ok = false; why = `round ${round}: contiguous=${contiguous} others=${others} checks=${checks}`; }
  }
  t(`${name}: 25 random edit sessions rebuild to a valid file (contiguous chunks, other chunks untouched, all checksums, sizes)`, ok, why);
}
console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
