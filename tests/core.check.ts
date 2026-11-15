import { readFileSync } from 'node:fs';
import { parseKsd, buildKsd, serializeLogicPayload, logicEquals, bytesEqual, graphName, checksumMismatches, chunkChecksum, KsdError, type LogicData } from '../src/app/ksd/ksd-core.ts';

const path = process.argv[2];
if (!path) { console.error('usage: tsx tests/core.check.ts <path to world0.ksd>'); process.exit(2); }
const orig = new Uint8Array(readFileSync(path));
let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

const p = parseKsd(orig);
check('parses', p.logic.graphs.length > 0, `${p.logic.graphs.length} graphs`);
check('custom strings read', p.customStrings.size > 0, `${p.customStrings.size} entries`);
const names = p.logic.graphs.map((g) => graphName(p, g));
check('every graph has a name', names.every((n) => !!n), JSON.stringify(names));
const total = (l: LogicData, k: 'nodes' | 'edges') => l.graphs.reduce((a, g) => a + g[k].length, 0);
check('node/edge totals survive serialize + re-parse', (() => { const again = parseKsd(buildKsd(p, p.logic)).logic; return total(again, 'nodes') === total(p.logic, 'nodes') && total(again, 'edges') === total(p.logic, 'edges'); })(), `${total(p.logic, 'nodes')} nodes, ${total(p.logic, 'edges')} links`);
check('every chunk\'s stored checksum == low 32 bits of XXH3-64 over the chunk', checksumMismatches(p).length === 0, `${p.entries.length} chunks`);
check('serialize(parse(x)) == original payload', bytesEqual(serializeLogicPayload(p.logic), p.logicPayload));
check('unedited rebuild is byte-identical', bytesEqual(buildKsd(p, p.logic), orig));

// --- edited rebuild: move a node, add an edge, remove two edges -> file length changes
const gi = p.logic.graphs.findIndex((x) => x.nodes.length >= 3 && x.edges.length >= 2);
const edited: LogicData = structuredClone(p.logic);
const g = edited.graphs[gi];
g.nodes[0].x += 123.5; g.nodes[0].y -= 40.25;
const removed = g.edges.splice(0, 2);
g.edges.push({ from: g.nodes[1].id, to: g.nodes[2].id, flag: 256 });
const built = buildKsd(p, edited);
const delta = built.length - orig.length;
check('edited file has expected length change', delta === -10, `delta=${delta}`);

const re = parseKsd(built);
check('edited file re-parses', true);
check('edited logic round-trips exactly', logicEquals(re.logic, edited));
check('node moved', Math.abs(re.logic.graphs[gi].nodes[0].x - Math.fround(edited.graphs[gi].nodes[0].x)) < 1e-6);
check('edge count updated', re.logic.graphs[gi].edges.length === p.logic.graphs[gi].edges.length - 1);
check('other graphs untouched', p.logic.graphs.every((_, i) => i === gi || logicEquals({ ...p.logic, graphs: [p.logic.graphs[i]] }, { ...re.logic, graphs: [re.logic.graphs[i]] })));
check('trailer preserved', bytesEqual(re.logic.trailer, p.logic.trailer));

// every other chunk must be byte-identical, and directory/offsets consistent
let chunksOk = true, offsetsOk = true;
for (const e of p.entries) {
  if (e.name === 'logic') continue;
  const e2 = re.entries.find(x => x.name === e.name)!;
  if (!bytesEqual(orig.subarray(e.offset, e.offset + e.size), built.subarray(e2.offset, e2.offset + e2.size))) chunksOk = false;
  if (e2.size !== e.size || e2.checksum !== e.checksum) chunksOk = false;
  const expectOff = e.offset > p.logicEntry.offset ? e.offset + delta : e.offset;
  if (e2.offset !== expectOff) offsetsOk = false;
}
check('all non-logic chunks byte-identical (data, size, checksum)', chunksOk);
check('later chunk offsets shifted by delta', offsetsOk);
check('header file size == actual', re.container.fileSize === built.length);
check('footer moved by delta', re.container.footerOffset === p.container.footerOffset + delta);
check('prefix before logic chunk identical (except header fields)', bytesEqual(orig.subarray(0x30, p.logicEntry.offset), built.subarray(0x30, p.logicEntry.offset)));
check('logic checksum is recomputed (changed) and correct', re.logicEntry.checksum !== p.logicEntry.checksum && re.logicEntry.checksum === chunkChecksum(built.subarray(re.logicEntry.offset, re.logicEntry.offset + re.logicEntry.size)));
check('every chunk checksum in the edited file verifies', checksumMismatches(re).length === 0);

// growth case too
const grown: LogicData = structuredClone(p.logic);
const gj = p.logic.graphs.findIndex((x) => x.nodes.length >= 21);
for (let i = 0; i < 20; i++) grown.graphs[gj].edges.push({ from: grown.graphs[gj].nodes[i].id, to: grown.graphs[gj].nodes[i + 1].id, flag: 0 });
const b2 = parseKsd(buildKsd(p, grown));
check('growth (+200 bytes) re-parses and matches', logicEquals(b2.logic, grown) && checksumMismatches(b2).length === 0);

// error handling
const expectThrow = (name: string, f: () => unknown) => { try { f(); check(name, false); } catch (e) { check(name, e instanceof KsdError, String((e as Error).message).slice(0, 70)); } };
expectThrow('rejects garbage', () => parseKsd(new Uint8Array(100)));
expectThrow('rejects truncated file', () => parseKsd(orig.subarray(0, orig.length - 5)));
const bad = orig.slice(); bad[p.logicEntry.offset + 14] ^= 0xff;
expectThrow('rejects corrupted logic length field', () => parseKsd(bad));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
