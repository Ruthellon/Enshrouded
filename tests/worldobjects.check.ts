/**
 * World Object lookup (entity_chunk00). Usage: npx tsx tests/worldobjects.check.ts <world.ksd> [more.ksd]
 * Prints how each World Object ref resolves and checks basic invariants. If a graph named
 * "Encounter 2 Passcode" exists (the user's world4), its known switch names are checked too.
 */
import { readFileSync } from 'node:fs';
import { graphName, parseKsd } from '../src/app/ksd/ksd-core';
import { indexWorldObjects, worldObjectLabel } from '../src/app/ksd/world-objects';

let failed = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

for (const file of process.argv.slice(2)) {
  console.log(`\n== ${file}`);
  const parsed = parseKsd(new Uint8Array(readFileSync(file)));
  const t0 = Date.now();
  const idx = indexWorldObjects(parsed);
  const counts = { named: 0, unnamed: 0, missing: 0, empty: 0 };
  let typeIdsOk = true;
  for (const g of parsed.logic.graphs) {
    for (const n of g.nodes.filter((x) => x.type === 0)) {
      if (!n.extra) {
        counts.empty++;
        continue;
      }
      const o = idx.lookup(n.extra);
      if (!o.found) counts.missing++;
      else if (o.name) counts.named++;
      else counts.unnamed++;
      if (o.found && !/^[0-9a-f]{8}$/.test(o.typeId ?? '')) typeIdsOk = false;
    }
  }
  console.log(`resolved in ${Date.now() - t0} ms:`, counts);
  const total = counts.named + counts.unnamed + counts.missing + counts.empty;
  if (total > 0) check(idx.available, 'entity_chunk00 decompressed');
  check(typeIdsOk, 'every found object has an 8-hex-digit type id');
  check(idx.lookup('zz') === idx.lookup('00000000') || !idx.lookup('zz').found, 'invalid ref is not found');
  check(worldObjectLabel('', null) === 'no object', 'empty ref label');

  // Spawner settings the user read in game (world2 / world4). Spawner 1's timeout differs between
  // those worlds (5 s in world2, 60 s in world4), so it is not checked.
  const spawners: Record<string, [string, number, number | null]> = {
    'EC1 Spawner 1': ['Fell Defender I', 0, null],
    'EC1 Spawner 2': ['Fell Defender I', 1, 60_000],
    'EC1 Spawner 3': ['Fell Soldier II', 2, 60_000],
    'EC1 Spawner 4': ['Fell Soldier II', 3, 90_000],
    'EC1 Spawner 5': ['Fell Crusader', 0, 62_500],
    'EC1 Spawner 6': ['Fell Commander', 0, 62_500],
  };
  const enc1 = parsed.logic.graphs.find((g) => graphName(parsed, g) === 'Encounter 1 v2');
  if (enc1) {
    const seen = new Map<string, ReturnType<typeof idx.lookup>>();
    for (const g of parsed.logic.graphs)
      for (const n of g.nodes) if (n.type === 0 && n.extra) {
        const o = idx.lookup(n.extra);
        if (o.name && spawners[o.name]) seen.set(o.name, o);
      }
    for (const [name, [enemy, level, ms]] of Object.entries(spawners)) {
      const s = seen.get(name)?.spawner;
      if (!seen.has(name)) continue;
      check(
        !!s && s.enemyName === enemy && s.levelOffset === level && (ms === null || s.timeoutMs === ms),
        `${name}: ${s?.enemyName} level ${s?.levelOffset} timeout ${s?.timeoutMs} ms`,
      );
    }
  }

  const pass = parsed.logic.graphs.find((g) => graphName(parsed, g) === 'Encounter 2 Passcode');
  if (pass) {
    const names = pass.nodes
      .filter((n) => n.type === 0)
      .map((n) => idx.lookup(n.extra))
      .filter((o) => o.typeName === 'Switch Button')
      .map((o) => o.name)
      .sort();
    check(
      JSON.stringify(names) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `EC2 Switch ${i}`)),
      `Encounter 2 Passcode switches resolve to EC2 Switch 1-8 (${names.join(', ')})`,
    );
  }
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
