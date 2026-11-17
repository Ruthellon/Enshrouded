/** Simulator behaviour checks (self-contained). Usage: npx tsx tests/simulator.check.ts */
import type { SparkGraph, SparkNode } from '../src/app/ksd/ksd-core';
import { GraphSim } from '../src/app/ksd/simulator';

let failed = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

const u64 = (ms: number): string => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(ms) * 1_000_000n, true);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};
let nextId = 1;
const node = (type: number, extra = ''): SparkNode => ({
  id: (nextId++).toString(16).padStart(8, '0'),
  x: 0,
  y: 0,
  type,
  hasExtra: extra ? 1 : 0,
  extra,
});
const graph = (nodes: SparkNode[], links: [SparkNode, SparkNode, number?][]): SparkGraph =>
  ({ graphId: '0'.repeat(26), timestampHex: '0'.repeat(16), nodes, edges: links.map(([a, b, s]) => ({ from: a.id, to: b.id, flag: (s ?? 0) << 8 })) }) as SparkGraph;
const run = (sim: GraphSim, ticks: number): void => {
  for (let i = 0; i < ticks; i++) sim.step();
};

// button -> NOT -> light: signal travels one link per tick
{
  const btn = node(0), not = node(5), light = node(0);
  const sim = new GraphSim(graph([btn, not, light], [[btn, not], [not, light]]), { tickMs: 50, pulseMs: 200 });
  run(sim, 2);
  check(sim.isOn(not.id) && sim.isOn(light.id), 'NOT of an idle button is ON and reaches the light');
  sim.push(btn.id);
  check(sim.isOn(btn.id) && sim.isOn(not.id), 'pushed button is ON at once; NOT has not reacted yet');
  sim.step();
  check(!sim.isOn(not.id) && !sim.isOn(light.id), 'in the next tick the change reaches the whole chain');
  const w = sim.waves();
  check(w.length === 2 && !w[0].has(not.id) && w[0].has(light.id) && !w[1].has(light.id), 'waves show it spreading link by link');
  run(sim, 4);
  check(!sim.isOn(btn.id) && sim.isOn(light.id), 'pulse ended after 200 ms and the light came back on');
}

// Toggle: the user's in-game test (Switch Button A -> UPPER, Switch Button B -> LOWER, light on the output)
{
  const a = node(0), b = node(0), tg = node(9);
  const sim = new GraphSim(graph([a, b, tg], [[a, tg, 0], [b, tg, 1]]), { tickMs: 50 });
  run(sim, 2);
  const steps: [SparkNode, 'on' | 'off', boolean, string][] = [
    [a, 'on', true, 'A ON: UPPER OFF->ON toggles'],
    [a, 'off', true, 'A OFF: UPPER ON->OFF does nothing'],
    [a, 'on', false, 'A ON: toggles again'],
    [b, 'on', true, 'B ON: LOWER OFF->ON copies UPPER (ON)'],
    [b, 'off', true, 'B OFF: LOWER ON->OFF does nothing'],
    [a, 'off', true, 'A OFF: nothing'],
    [b, 'on', false, 'B ON: LOWER OFF->ON copies UPPER (OFF)'],
    [a, 'on', true, 'A ON with B still ON: toggles (LOWER held ON does not block)'],
    [b, 'off', true, 'B OFF: nothing'],
  ];
  steps.forEach(([obj, mode, want, msg], i) => {
    sim.setObject(obj.id, mode);
    run(sim, 2);
    check(sim.isOn(tg.id) === want, `Toggle step ${i + 1}: ${msg}`);
  });
}

// Toggle in a loop with its own LOWER ("Encounter 1 v2": Toggle -> Spawner -> Save ch21, Use ch21 -> NOT -> LOWER).
// In game the spawner keeps spawning: LOWER rising on a kill copies UPPER (ON), so the Toggle stays ON.
{
  const a = node(0), tg = node(9), sp = node(0), save = node(11, '14'), use = node(12, '14'), not = node(5);
  const sim = new GraphSim(graph([a, tg, sp, save, use, not], [[a, tg, 0], [tg, sp], [sp, save], [use, not], [not, tg, 1]]), {
    tickMs: 50,
    spawners: new Map([[sp.id, 200]]),
  });
  run(sim, 2);
  sim.setObject(a.id, 'on');
  run(sim, 2);
  check(sim.isOn(tg.id) && sim.isOn(sp.id) && !sim.isOn(not.id), 'loop: Toggle ON, enemy spawned, LOWER OFF');
  sim.defeat(sp.id);
  run(sim, 2);
  check(sim.isOn(tg.id) && !sim.isOn(sp.id) && sim.isOn(not.id), 'loop: enemy killed, LOWER ON, Toggle stays ON');
  run(sim, 5);
  check(sim.isOn(tg.id) && sim.isOn(sp.id), 'loop: next enemy spawns');
}

// Hold keeps ON for its delay
{
  const a = node(0), h = node(1, u64(300));
  const sim = new GraphSim(graph([a, h], [[a, h]]), { tickMs: 50, pulseMs: 50 });
  sim.push(a.id);
  run(sim, 2);
  check(sim.isOn(h.id), 'Hold ON');
  run(sim, 4);
  check(sim.isOn(h.id), 'Hold still ON within 300 ms');
  run(sim, 4);
  check(!sim.isOn(h.id), 'Hold OFF after 300 ms');
}

// Timed Trigger: OFF for delay, ON for interval
{
  const a = node(0), tt = node(10, u64(200) + u64(100));
  const sim = new GraphSim(graph([a, tt], [[a, tt, 0]]), { tickMs: 50, pulseMs: 50 });
  sim.push(a.id);
  const seen: boolean[] = [];
  for (let i = 0; i < 10; i++) seen.push((sim.step(), sim.isOn(tt.id)));
  const onTicks = seen.filter(Boolean).length;
  check(!seen[0] && !seen[3] && onTicks === 2, `Timed Trigger waits 200 ms then is ON for 100 ms (${seen.map(Number).join('')})`);
}

// Timed Trigger whose LOWER (reset) is a NOT of its UPPER source (pattern used throughout the user's saves)
{
  const zone = node(0), not = node(5), tt = node(10, u64(200) + u64(100)), out = node(4);
  const sim = new GraphSim(graph([zone, not, tt, out], [[zone, tt, 0], [zone, not], [not, tt, 1], [tt, out]]), { tickMs: 50 });
  run(sim, 3);
  sim.setObject(zone.id, 'on');
  const seen: boolean[] = [];
  for (let i = 0; i < 10; i++) seen.push((sim.step(), sim.isOn(out.id)));
  check(seen.filter(Boolean).length === 2 && !seen[3] && seen[4], `zone ON starts the trigger despite the reset path (${seen.map(Number).join('')})`);
  sim.setObject(zone.id, 'off');
  run(sim, 2);
  sim.setObject(zone.id, 'on');
  run(sim, 1);
  sim.setObject(zone.id, 'off');
  const seen2: boolean[] = [];
  for (let i = 0; i < 8; i++) seen2.push((sim.step(), sim.isOn(out.id)));
  check(!seen2.some(Boolean), 'leaving the zone during the delay resets it (no output)');
}

// Clock alternates while enabled
{
  const c = node(2, u64(100));
  const sim = new GraphSim(graph([c], []), { tickMs: 50 });
  const seen: boolean[] = [];
  for (let i = 0; i < 8; i++) seen.push((sim.step(), sim.isOn(c.id)));
  // ON for 0-99 ms (shown at t=0 and t=50), OFF for 100-199 ms, ...; ticks below start at t=50
  check(seen.map(Number).join('') === '10011001', `unlinked Clock runs with a 100 ms interval (${seen.map(Number).join('')})`);
}

// Save / Use Signal on the same channel
{
  const a = node(0), s = node(11, '04'), u = node(12, '04'), u2 = node(12, '05');
  const sim = new GraphSim(graph([a, s, u, u2], [[a, s]]), { tickMs: 50 });
  sim.setObject(a.id, 'on');
  run(sim, 3);
  check(sim.isOn(u.id) && !sim.isOn(u2.id), 'Use Signal follows the Save Signal of its channel only');
}

// gates, D Flip-Flop, Flank
{
  const a = node(0), b = node(0), and = node(3), or = node(4), xor = node(7), nand = node(6), d = node(8), f = node(15);
  const sim = new GraphSim(
    graph([a, b, and, or, xor, nand, d, f], [[a, and], [b, and], [a, or], [b, or], [a, xor], [b, xor], [a, nand], [b, nand], [a, d, 0], [b, d, 1], [a, f]]),
    { tickMs: 50 },
  );
  sim.setObject(a.id, 'on');
  run(sim, 2);
  check(!sim.isOn(and.id) && sim.isOn(or.id) && sim.isOn(xor.id) && sim.isOn(nand.id), 'gates with A=ON, B=OFF');
  check(!sim.isOn(d.id), 'D Flip-Flop holds while LOWER is OFF');
  check(!sim.isOn(f.id), 'Flank was ON for one tick only');
  sim.setObject(b.id, 'on');
  run(sim, 2);
  check(sim.isOn(and.id) && !sim.isOn(xor.id) && !sim.isOn(nand.id), 'gates with A=ON, B=ON');
  check(sim.isOn(d.id), 'D Flip-Flop stores UPPER when LOWER is ON');
  sim.setObject(b.id, 'off');
  sim.setObject(a.id, 'off');
  run(sim, 2);
  check(sim.isOn(d.id), 'D Flip-Flop keeps its value after LOWER goes OFF');
}

// D Flip-Flop as the user describes it: LOWER ON passes and stores UPPER; LOWER OFF holds the last value
{
  const up = node(0), en = node(0), d = node(8);
  const sim = new GraphSim(graph([up, en, d], [[up, d, 0], [en, d, 1]]), { tickMs: 50 });
  sim.setObject(en.id, 'on');
  sim.setObject(up.id, 'on');
  run(sim, 2);
  check(sim.isOn(d.id), 'DFF: LOWER ON + UPPER ON -> ON');
  sim.setObject(up.id, 'off');
  run(sim, 2);
  check(!sim.isOn(d.id), 'DFF: LOWER ON follows UPPER to OFF');
  sim.setObject(up.id, 'on');
  run(sim, 2);
  sim.setObject(en.id, 'off');
  run(sim, 2);
  sim.setObject(up.id, 'off');
  run(sim, 3);
  check(sim.isOn(d.id), 'DFF: after LOWER goes OFF it holds ON although UPPER went OFF');
  sim.setObject(up.id, 'on');
  sim.setObject(up.id, 'off');
  run(sim, 3);
  check(sim.isOn(d.id), 'DFF: still holding');
}

// Latch with feedback (user's "Encounter 1 v2"): plate -> DFF UPPER; DFF -> Save ch1; Use ch1 -> NOT -> DFF LOWER
{
  const plate = node(0), d = node(8), save = node(11, '00'), use = node(12, '00'), not = node(5);
  const sim = new GraphSim(graph([plate, d, save, use, not], [[plate, d, 0], [d, save], [use, not], [not, d, 1]]), { tickMs: 50 });
  run(sim, 3);
  check(!sim.isOn(d.id) && sim.isOn(not.id), 'latch idle: OFF, sampling');
  sim.setObject(plate.id, 'on');
  const seen: boolean[] = [];
  for (let i = 0; i < 6; i++) seen.push((sim.step(), sim.isOn(d.id)));
  check(seen.every(Boolean), `latch turns ON and stays ON (${seen.map(Number).join('')})`);
  check(!sim.isOn(not.id), 'latch stopped sampling (LOWER OFF)');
  sim.setObject(plate.id, 'off');
  run(sim, 5);
  check(sim.isOn(d.id), 'latch holds ON after the plate is released');
}

// Spawner: ON while switched on and its enemy lives; defeating it gives OFF until the respawn
{
  const zone = node(0), sp = node(0), light = node(4), free = node(0);
  const sim = new GraphSim(graph([zone, sp, light, free], [[zone, sp], [sp, light]]), {
    tickMs: 50,
    spawners: new Map([[sp.id, 200], [free.id, 0]]),
  });
  run(sim, 2);
  check(!sim.isOn(sp.id) && !sim.defeat(sp.id), 'spawner OFF while its input is OFF; nothing to defeat');
  check(!sim.isOn(free.id), 'unlinked spawner is off');
  sim.setObject(free.id, 'on');
  sim.setObject(zone.id, 'on');
  run(sim, 2);
  check(sim.isOn(sp.id) && sim.isOn(light.id), 'spawner switched on: enemy alive, output ON');
  check(sim.defeat(sp.id) && !sim.isOn(sp.id), 'defeating the enemy turns it OFF at once');
  run(sim, 1);
  check(!sim.isOn(light.id) && sim.respawnIn(sp.id) === 200, `the graph sees it; next enemy in 200 ms (${sim.respawnIn(sp.id)})`);
  run(sim, 3);
  check(!sim.isOn(sp.id), 'still OFF before the timeout');
  run(sim, 1);
  check(sim.isOn(sp.id) && sim.isOn(light.id) && sim.enemyAlive(sp.id), 'next enemy spawned after the Spawn Timeout: ON again');
  sim.defeat(sp.id);
  sim.setObject(zone.id, 'off');
  run(sim, 1);
  sim.setObject(zone.id, 'on');
  run(sim, 1);
  check(sim.isOn(sp.id), 'switching a spawner off and on spawns a new enemy at once');
  sim.defeat(free.id);
  const seen: boolean[] = [];
  for (let i = 0; i < 3; i++) seen.push((sim.step(), sim.isOn(free.id)));
  check(seen.map(Number).join('') === '011', `timeout 0: OFF for one tick (${seen.map(Number).join('')})`);
}

// Timed Trigger with delay 0 and interval 0: ON for exactly one tick
{
  const a = node(0), tt = node(10, u64(0) + u64(0));
  const sim = new GraphSim(graph([a, tt], [[a, tt, 0]]), { tickMs: 50 });
  run(sim, 2);
  sim.setObject(a.id, 'on');
  const seen: boolean[] = [];
  for (let i = 0; i < 4; i++) seen.push((sim.step(), sim.isOn(tt.id)));
  check(seen.map(Number).join('') === '1000', `Timed Trigger 0/0 gives a one-tick pulse (${seen.map(Number).join('')})`);
}

// Counter made of Save/Use latches ("Encounter 1 v2" lives): each pulse must take one step only, which needs
// a Use Signal to see its Save Signal one tick later
{
  const p = node(0), or = node(4);
  const notA = node(5), andA = node(3), dA = node(8), saveA = node(11, '01'), useA = node(12, '01');
  const notB = node(5), andB = node(3), dB = node(8), saveB = node(11, '02'), useB = node(12, '02');
  const sim = new GraphSim(
    graph(
      [p, or, notA, andA, dA, saveA, useA, notB, andB, dB, saveB, useB],
      [
        [p, or],
        [or, andA], [notA, andA], [useA, notA], [andA, dA, 0], [notA, dA, 1], [dA, saveA],
        [or, andB], [useA, andB], [notB, andB], [useB, notB], [andB, dB, 0], [notB, dB, 1], [dB, saveB],
      ],
    ),
    { tickMs: 50, pulseMs: 50 },
  );
  run(sim, 3);
  sim.push(p.id);
  run(sim, 4);
  check(sim.isOn(useA.id) && !sim.isOn(useB.id), 'counter: first pulse sets stage 1 only');
  sim.push(p.id);
  run(sim, 4);
  check(sim.isOn(useA.id) && sim.isOn(useB.id), 'counter: second pulse sets stage 2');
}

// No glitch where a fast and a slow path meet: AND(A, NOT A) must never flash ON, not even in the waves
{
  const a = node(0), not = node(5), and = node(3), d = node(8), en = node(13);
  const sim = new GraphSim(graph([a, not, and, d, en], [[a, and], [a, not], [not, and], [and, d, 0], [en, d, 1]]), { tickMs: 50 });
  run(sim, 2);
  let flashed = false;
  for (const mode of ['on', 'off', 'on'] as const) {
    sim.setObject(a.id, mode);
    for (let i = 0; i < 3; i++) {
      sim.step();
      if (sim.isOn(and.id) || sim.waves().some((w) => w.has(and.id) || w.has(d.id))) flashed = true;
    }
  }
  check(!flashed, 'AND(A, NOT A) never flashes ON when A changes');
}

// Global Reset
{
  const a = node(0), r = node(0), tg = node(9), gr = node(16);
  const sim = new GraphSim(graph([a, r, tg, gr], [[a, tg, 0], [r, gr]]), { tickMs: 50, pulseMs: 50 });
  sim.push(a.id);
  run(sim, 3);
  sim.push(r.id);
  run(sim, 3);
  check(!sim.isOn(tg.id), 'Global Reset clears a Toggle');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
