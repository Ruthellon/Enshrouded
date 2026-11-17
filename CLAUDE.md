# CLAUDE.md — Enshrouded Sparkworks Editor

Project memory for Claude Code. This file is the hand-off from the chat in which the project was built.
Read it fully before changing anything. Facts are labelled **VERIFIED** (checked byte-for-byte against
game-written saves or confirmed by the user in the game), **INFERRED** (fits all evidence, not proven) or
**UNKNOWN**.

## 1. What this project is

A browser-only **Angular 20** app (TypeScript, HTML, CSS) that:

1. loads an Enshrouded world file (`world0.ksd`),
2. shows its **Sparkworks** (logic-circuit) graphs on an SVG canvas,
3. lets the user move nodes, add/delete nodes (200-per-graph limit), edit links (upper/lower input slot),
   Save/Use Signal channels (1–32) and Hold/Clock/Timed Trigger times,
4. exports a new `.ksd` the game accepts.

Nothing is uploaded; all parsing/writing happens in the browser. The format is **reverse-engineered**, not
documented. Never overwrite the user's only copy of a save; the UI and README tell users to back up.

Companion Python tools live in `tools/` (see section 11).

## 2. Commands

```bash
npm install
npm start                 # ng serve → http://localhost:4200   (Node 20.19+ or 22.12+)
npm run build             # production build → dist/

# Tests (tsx; need real save files, see section 9)
npx tsx tests/xxh3.check.ts                                     # self-contained
npx tsx tests/core.check.ts  <any.ksd>
npx tsx tests/model.check.ts <world0.ksd>                       # written for the ORIGINAL save (142 checks)
npx tsx tests/gamefiles.check.ts <base> <moved> <add> <delete>  # writer vs game output, byte-for-byte
```

State of the repo when handed over: the four test commands above all pass against the user's saves.
**`ng build` / `ng serve` have never been run** (the sandbox had no network). The first job in VS Code is
`npm install && npm run build` and fixing whatever the real Angular compiler reports (see section 10).

## 3. Conventions

- Angular 20: standalone components, **signals** (`signal/computed/effect/input/output/viewChild`),
  `ChangeDetectionStrategy.OnPush`, new control flow (`@if/@for`), no NgModules.
- **Everything under `src/app/ksd/` is plain TypeScript with no Angular, DOM or Node imports.** Keep it that
  way: it is what makes the tests runnable with `tsx`. Tests (not the app) may use `node:fs`.
- Edit operations are **immutable**: they return a new `LogicData` sharing unchanged parts, or a
  `Result<T> = {ok:true,data}|{ok:false,reason}`. State changes go through `History<T>` for undo/redo.
- Byte-exactness beats tidiness: anything not understood is **preserved verbatim** (graph ids, timestamps,
  trailer, unknown chunks).
- Git commit attribution (from the session environment): end commit messages with
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LUoKEfka3eRx3mX53qQS45`; end PR bodies with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)` plus the same session URL.

## 4. File format (reverse-engineered)

### 4.1 Container `SV2C`

```
0x00 'SV2C'   0x04 u16 version(2)   0x06 u16 header size(48)   0x08 u32 file size
0x0c 16-byte world id   0x1c u32 (?)   0x20 u64 unix timestamp
0x28 u32 footer offset   0x2c u32 chunk count
chunks are contiguous after the header
footer @ footerOffset = 40 zero bytes
                      + N × 20-byte entries <u32 rel_name_off, u32 name_len, u32 offset, u32 size, u32 checksum>
                      + concatenated names   (name at entry_pos + rel_name_off)
```

### 4.2 Chunk `S2BH`

`'S2BH'`, u32 format version (2), u16 type (**high byte 1 = zstd**), u32 schema version = **14-byte header**,
then payload. zstd chunks in the samples: `entity_chunk00`, `snapping` (inner `SBV2`), `world_knowledge`.
`logic`, `custom_strings`, `game_settings` are uncompressed. 17 chunks in the sample saves.

### 4.3 The checksum — the "game says the file is corrupted" bug (VERIFIED)

Each directory entry's checksum = **low 32 bits of XXH3-64 (seed 0, default 192-byte secret) over the chunk's
complete bytes, including the 14-byte header.** Verified on 85/85 entries across 5 game-written files.
Exporting unchanged data worked in the game; *any* edit failed until this checksum was recomputed.
All CRC32 variants, xxh32/xxh64, murmur, fnv, md5/sha, lookup3 etc. were tried and failed — do not redo that.
`src/app/ksd/xxh3.ts` is a BigInt TypeScript implementation (matches libxxhash on 851 vectors;
~67 ms for 17 chunks / 2.6 MB).

### 4.4 `logic` payload

```
u32 byteLengthOfRest   u32 version(6)   u32 graphCount
per graph:
  13-byte id  = 5-byte prefix + 8-byte key into custom_strings
  u64 timestamp
  u32 nodeCount
  nodes:  u32 id | f32 x | f32 y | u8 type | u8 hasExtra | extra bytes
  u32 edgeCount
  edges:  u32 from | u32 to | u16 flag
then a ~1104-byte trailer ("runtime-state table") — preserved verbatim, NOT understood.
```

Extra bytes (only when `hasExtra != 0`):

| type | extra | new-node default (game-written) |
|---|---|---|
| 0 World Object | 4-byte object ref, or none | **no extra** (`hasExtra=0`) |
| 1 Hold | u64 ns **delay** | 0.5 s |
| 2 Clock | u64 ns **interval** | 0.5 s |
| 10 Timed Trigger | u64 ns delay, u64 ns interval | delay 1 s, interval 0 |
| 11 Save / 12 Use | 1 byte = **channel − 1** (channels 1–32) | channel 1 |
| all others | none | none |

Max duration 10:0:000 (600 000 ms), displayed `m:s:ms`.

**Edge flag:** high byte = target **input slot**: `0` = UPPER / only input, `1` = LOWER (**VERIFIED in-game**).
Low byte has only ever been 0; preserved.

### 4.5 `custom_strings` and graph names

`u32 count`, then `count × (8-byte key, u32 len, UTF-8 text)`. A graph's name is
`customStrings.get(graphId.slice(10))` (hex chars 10..26 = last 8 bytes of the 13-byte id).
Graph 0 = "Dungeon Door" in the original save (user-confirmed). 148 strings in the original.

### 4.5a World Object refs → `entity_chunk00` (found 2026-11-16, read-only analysis)

A World Object node's 4-byte extra is an **entity id** in the zstd-compressed `entity_chunk00` chunk. Around it:
`[u32 object-type id][4-byte entity id][1 byte ?][8-byte custom_strings key = player-given name]`
(name key at entity offset +5; ids searched byte-aligned and found only there). Checked on three of the user's
worlds: world4 145 refs → 104 named, 20 found but unnamed, 21 not in the save at any bit offset (17 in
"Encounter 1", 4 in "Dungeon Door"; cause unknown), 1 empty. world1/world2 behave the same.
Type ids **user-confirmed** in-game: `a2455b47` = Switch Button, `766656b9` = Door, `71b5fbd5` = Pressure Plate
(**output only, no inputs** — enforced via the optional `OutputOnlyCheck` argument of `ruleIssue`/`validateGraph`/
`addEdge`/…, fed from `OUTPUT_ONLY_OBJECT_TYPES`), `ea26760e` = Torch, `a6dc827c` = Spawner.
Spawner settings in game: Spawned Enemy (choice), Spawn Timeout (m:s:ms, wait after the enemy is killed), Level
Offset (−5…+5 vs player level). **VERIFIED** against six spawners set in game (offsets from the entity id):
`+13` 4-byte enemy id · `+17` i8 level offset · `+18` u64 ns spawn timeout. Enemy ids: `1d2a1178` Fell Defender I,
`b862338b` Fell Soldier II, `5e56f58b` Fell Crusader, `71153792` Fell Commander, `a76ce83e` Fell Scout II, `050ffb09` Fell Marksman
(`KNOWN_ENEMIES`; `3fd871ec` in world1 still unknown). The game
displays 62.5 s as "1:2:5". Shown read-only in the Selection panel; editing would mean rewriting entity_chunk00. Type ids are consistent across worlds; their names are
not in the save (presumably hashes of game asset names). Flame Altar names ("Dungeon Spawn 2") are also
custom_strings referenced from `entity_chunk00`. **User-confirmed:** a World Object only resolves in-game when the
player is at the Flame Altar that owns it; the field linking entity → altar is **UNKNOWN**.
**VERIFIED (world2, 2026-11-16):** re-linking a World Object node in-game at a different altar ("Dungeon Start")
rewrote that node's stored ref (`c8247d09` Door → `abfb5721`, type `d4c57f10`, a light); no other ref changed and
the door's entity record stayed. So one stored ref = one object; the ref changes when the link changes.
Type `d4c57f10` is very likely a light (all named examples are lights). The light was newly placed
(user-confirmed), which is why its record was absent from the earlier copy. The 21 refs absent from world4 are
still unexplained (deleted objects? objects stored elsewhere?).
In the app (read-only) via `src/app/ksd/world-objects.ts` (`indexWorldObjects`, `KNOWN_OBJECT_TYPES`,
`worldObjectLabel`), using the `fzstd` npm package to decompress `entity_chunk00`. That chunk is never written.
Add newly confirmed type ids to `KNOWN_OBJECT_TYPES`. Test: `npx tsx tests/worldobjects.check.ts <world.ksd>...`.

### 4.6 `game_settings` (128-byte payload; decoded read-only)

Packed, unpadded, 38 values in the order of the documented server `gameSettings` keys. f32 = factors,
u8 = bool / enum (enum stored as index into the documented option list), u64 = nanoseconds,
`flameLevelFogRemoval` = u8. Full schema: `tools/ksd_game_settings.py` (`SCHEMA`, `DEFAULTS`, encode/decode
round-trip checked). Sample save differs from the "Default" preset in 7 keys: aggroPoolAmount=Many,
enemyDamageFactor 1.25, enemyHealthFactor 1.5, enemyPerceptionRangeFactor 1.75, bossDamageFactor 1.5,
bossHealthFactor 2.0, threatBonus 1.5. INFERRED: `Many` enum index comes from documented option order.
Editing game_settings is **not implemented** (optional future work).

## 5. Behaviours copied from the game (VERIFIED byte-for-byte)

Compared against the user's game-written `world0_moved/add/delete.ksd`:

- **Add:** new node is **appended** to the graph's node list; id = random 4 bytes, unique across the whole file.
- **Delete:** **swap-remove** — the *last* node takes the freed slot; every edge touching the node is removed.
  (The first implementation shifted the list and did not match.)
- **Move:** only x/y change.
- Nothing outside a graph's node list references node ids.
- The game rewrites graph timestamps and the trailer on its own saves; the editor leaves them untouched.
  In the byte-comparison tests, timestamps/trailer are copied from the game's file for that reason.

## 6. Sparkworks node types and rules

| # | Name | Category (colour) | Inputs | Output |
|---|---|---|---|---|
| 0 | World Object | world (gray `#9aa0a6`) | many | yes |
| 1 | Hold | time (pink `#f08bb4`) | single | yes |
| 2 | Clock | time | single | yes |
| 3 | AND | logic (blue `#5b9cf0`) | many | yes |
| 4 | OR | logic | many | yes |
| 5 | NOT | logic | single | yes |
| 6 | NAND | logic | many | yes |
| 7 | XOR | logic | many | yes |
| 8 | D Flip-Flop | state (purple `#a98bf0`) | upperLower | yes |
| 9 | Toggle | state | upperLower | yes |
| 10 | Timed Trigger | time | upperLower | yes |
| 11 | Save Signal | state | single | **no** |
| 12 | Use Signal | state | none | yes |
| 13 | On | logic | none | yes |
| 14 | Off | logic | none | yes |
| 15 | Flank | state | single | yes |
| 16 | Global Reset | state | single | **no** |

Rules enforced by `ruleIssue` (toggleable in the UI): no input to Use/On/Off; no output from Save/Global
Reset; single-input nodes take one link; upperLower nodes take one link on each of UPPER and LOWER; many-input
nodes unlimited; **one Save Signal per channel per graph**; a Use Signal may not link directly to a Save Signal
of the same channel. All 588 edges in the original save pass these rules.
**The 200-node-per-graph limit is always enforced** (not toggleable).
Semantics (shown as tooltips): D Flip-Flop — LOWER ON samples and stores UPPER, LOWER OFF holds; Toggle (**VERIFIED in game**, 9-step
switch test 2026-11-16) — UPPER OFF→ON flips it; LOWER OFF→ON *copies UPPER's current value* (so it is a reset only
while UPPER is OFF); ON→OFF on either input does nothing; LOWER held ON does not block toggling. This is what keeps
the Spawner loop in "Encounter 1 v2" (Toggle 87fa) running: a kill raises LOWER while UPPER is ON; Timed Trigger — UPPER off→on waits `delay`, then ON for `interval`,
LOWER ON resets.

## 7. Architecture

```
src/app/ksd/ksd-core.ts          parse/serialize container + logic chunk, checksums, graph names, buildKsd
src/app/ksd/xxh3.ts              XXH3-64 (BigInt)   exports xxh3_64(data): bigint, xxh3Low32(data): number
src/app/ksd/sparkworks-types.ts  node table, colours, channels, durations, defaults, subtitles
src/app/ksd/node-shapes.ts       node geometry, gate symbols, slot (port) positions
src/app/ksd/graph-model.ts       immutable edit ops, rule checks, change summary, History<T>
src/app/ksd/graph-geometry.ts    viewport/zoom/fit, hit boxes, bezier link path
src/app/ksd/world-objects.ts     World Object ref → entity_chunk00 record (name, type id); read-only, uses fzstd
src/app/ksd/simulator.ts         GraphSim: tick-based simulation of one graph for Test mode (section 7.3)
src/app/graph-canvas/            SVG canvas component (pointer handling, hit-testing, drawing)
src/app/node-icon/               small node picture for legend / palette
src/app/app.{ts,html,css}        shell: upload, graph list, tools, palette, side panels, undo/redo, export
tests/                           tsx checks (section 9)
tools/                           Python tools (section 11)
```

### 7.1 Key decisions

1. **Only the `logic` chunk is rewritten.** All other chunks are copied byte-for-byte. `buildKsd` updates the
   header file size (0x08), footer offset (0x28), the logic directory entry's size (+12) and checksum (+16),
   and shifts offsets of chunks stored after it. If the new payload equals the old one, the original bytes are
   returned (so "export with no edits" is byte-identical).
   ```ts
   for (const entry of parsed.entries) {
     const at = dirStart + DIR_ENTRY_SIZE * entry.dirIndex;
     if (entry === e || entry.name === 'logic') {
       v.setUint32(at + 12, newChunkSize, true);
       v.setUint32(at + 16, chunkChecksum(out.subarray(e.offset, e.offset + newChunkSize)), true);
     } else if (entry.offset > e.offset) {
       v.setUint32(at + 8, entry.offset + delta, true);
     }
   }
   ```
2. **Unknown data is preserved, unknown types refuse loudly.** A node type with extra data that isn't in
   `EXTRA_LEN` throws `KsdError` rather than risk corrupting a save.
3. **Export self-verifies before download:** rebuild → re-parse → `logicEquals` with what the UI shows →
   checksum check (ignoring chunks already wrong at load). If anything fails, nothing is downloaded. A warning
   bar appears when the *loaded* file already has bad checksums (e.g. exported by an older version).
4. **Slot-aware linking in the UI.** Output slot (right edge) drag/click starts a link in any tool; dropping on a
   specific input slot picks UPPER/LOWER; dropping on a node body uses `autoSlot` (first free input).
   `ConnectRequest {from,to,slot?}`.
5. **Rendering:** logic gates drawn as their schematic symbols (`GATE_SCALE=1.4`), everything else as
   rectangles (`BOX_W=112`, `BOX_H=52`, `PORT_R=6.5`) with visible ports: inputs left, output right;
   upperLower inputs at `y = ∓BOX_H/4` (upper = slot 0, orange = LOWER). Node size slider 0.4–1.8 (default 1).
   Cues: yellow dashed ring = moved/changed, green dashed = added, white = selected.
   **Zoom-dependent size** (View → "Shrink nodes when zoomed out", default on): drawn size =
   `nodeScale × clamp(zoom × footprint, 0.12, 1)` (`drawScale` in graph-canvas.ts). `graphFootprint` = room per
   node in node-sizes from nearest neighbours (5th percentile × 0.9), measured on each Fit (not on every edit, so
   sizes don't jitter while dragging). Labels hide below draw scale 0.5; tooltips still name nodes. At Fit on a
   1100×750 canvas this took "Encounter 1 v2" (199 nodes) from 1491 overlapping pairs to 0.
6. **Defaults for new nodes match what the game writes** (section 4.4); World Object has no object ref and must
   be linked in-game; duplicating a World Object produces an unassigned one; a duplicated Save Signal gets the
   lowest free channel; a new Use Signal takes the lowest channel that has a Save.
7. **Y axis**: the game's y-axis orientation was never confirmed, so the canvas has a "Flip Y" toggle.

### 7.3 Test mode (simulator)

"Test graph" (stage header) runs `GraphSim` on the open graph; editing is blocked meanwhile (canvas `testing`
input, keyboard shortcuts off, undo/redo/revert disabled); Space = play/pause. Each tick (50 ms game time)
signals first **settle** through the whole graph, then Hold/Clock/Toggle/DFF/Timed
Trigger state is committed from the settled inputs. (An earlier version moved signals one link per tick; that broke
the common pattern "zone → TT UPPER, zone → NOT → TT LOWER": the stale reset swallowed the start, so Timed
Triggers never fired.) Settling evaluates nodes in **link (topological) order** with the newest values, repeating
only for loops (`GraphSim.order`, `linkOrder`). An earlier round-by-round (Jacobi) settle produced glitches where
paths of different length meet: in "Encounter 1 v2" AND 8819 (OR 849a & Use ch2 & NOT ch3) flashed ON for a round
when Use ch2 came on while the pulse's OFF was still travelling through OR 849a, briefly feeding Save ch3.
For display, `GraphSim.waves()` reveals the tick's final changes by link depth (a changed node one step after the
latest changed node feeding it); the app plays them one per frame before advancing time.
D Flip-Flop (**user-confirmed**): LOWER ON = transparent (passes and stores UPPER), LOWER OFF = hold last value.
Its memory is tracked *within* settling (`GraphSim.work`): otherwise a latch whose own output turns its LOWER off
(plate → DFF → Save ch1, Use ch1 → NOT → LOWER, as in "Encounter 1 v2") fell back to the pre-tick value and
oscillated. Toggle likewise tracks its memory and last-seen inputs per settling round (`GraphSim.toggleWork`):
comparing with the previous tick counted one UPPER change in every round, so the loop Toggle → Spawner → Save ch21 /
Use ch21 → NOT → its own LOWER (world2 "Encounter 1 v2", Toggle 87fa) flipped back ON after its reset (that was under an earlier, wrong Toggle rule; see section 6). Playback speed: 1× = one tick per 0.5 s real time (default),
10× = real time (`REAL_TIME_SPEED` in app.ts). Save Signals (no output) show a "stores ON/OFF" badge and the live ring from their input (computed in
graph-canvas `nodes`). Clicking a World Object with no incoming links toggles it ON/OFF
(Switch Buttons latch: inferred from "Encounter 2 Passcode", an AND of eight switches + NOTs, code `10111001`
matches the in-game hint string); the panel also has Push (0.5 s pulse) / ON / OFF / Auto.
**Spawners** (**user-confirmed** behaviour): while its input is ON a spawner keeps an enemy alive; input OFF despawns
it. Output = spawner ON AND enemy alive; when the enemy dies the output is OFF until the next enemy spawns after the
Spawn Timeout. In Test mode (`SimOptions.spawners`: node id → timeout ms, built from `indexWorldObjects` in
`startTest`) clicking a spawner node (or "Defeat enemy") = defeating its enemy (`GraphSim.defeat`).
**User-confirmed:** an unlinked spawner is OFF; off→on spawns a new enemy at once (no timeout); timeout 0 respawns
immediately after a defeat. Simulator choices: the timeout runs from the tick the graph sees the defeat, and timeout 0
still gives one OFF tick (50 ms, not visible in game; assumed to exist so the graph can react).
**ASSUMPTIONS to confirm in game** (all marked in `simulator.ts`): World Object output = OR of its inputs (or the
user's override); Clock with nothing linked runs freely, starts ON; AND/NAND with no inputs; Timed Trigger interval
0 = one-tick pulse; Flank pulse = one tick; Hold = ON while input ON and for `delay` after it went ON; Use Signal
sees its Save Signal's input **one tick later** (INFERRED: otherwise the life counter in "Encounter 1 v2" — six
zero-length Timed Triggers → OR 849a → latches on ch2/ch3/ch4 — lost every life to one pulse; `GraphSim.stored`); channels are per graph; Global Reset clears memory/timers of this
graph only (game: all graphs).
Open question: in world2 "Encounter 1 v2", TT 62c8's UPPER is Use ch12, and Save ch12 = AND(TT 62c8, NOT ch13),
so it can never start in the simulator. Either a graph bug, or channels/Use behave differently in game (e.g.
shared across graphs).
Tests: `npx tsx tests/simulator.check.ts` (self-contained).

### 7.2 Public API (signatures)

`ksd-core.ts`: `parseKsd(bytes) → ParsedKsd`, `buildKsd(parsed, logic) → Uint8Array`,
`serializeLogicPayload`, `parseLogicPayload`, `logicEquals`, `checksumMismatches`, `chunkChecksum`,
`readCustomStrings`, `graphKey`, `graphName`, `bytesToHex/hexToBytes/bytesEqual`, `KsdError`,
types `SparkNode {id,x,y,type,hasExtra,extra}`, `SparkEdge {from,to,flag}`,
`SparkGraph {graphId,timestampHex,nodes,edges}`, `LogicData {version,graphs,trailer}`.

`graph-model.ts`: `moveNode`, `addEdge`, `removeEdge`, `reverseEdge`, `setEdgeSlot`, `setChannel`,
`setDuration`, `insertNode`, `duplicateNode`, `deleteNode` (→ `{data, removedEdges, orphanedUses}`),
`moveNodes` (group move, one graph update), `deleteNodes` (sequential `deleteNode` in selection order),
`selectedNodeIds`, `selectNodes` (normalises to null / `{kind:'node'}` / `{kind:'nodes',ids}`), `toggleNodeSelection`,
`newNodeId`, `autoSlot`, `structuralIssue`, `ruleIssue`, `connectionIssue`, `validateGraph`,
`summarizeChanges`, `edgeKey` (`from>to#flag`), `slotOf` (`flag>>8`), `withSlot`, `class History<T>`.

`sparkworks-types.ts`: `NODE_TYPES`, `typeInfo/typeName/typeColor/slotLabel`, `hasChannel/channelOf/channelExtra`,
`DURATION_FIELDS`, `readDurations/writeDuration/formatDuration/parseDuration`, `MAX_NODES_PER_GRAPH=200`,
`INSERTABLE_TYPES`, `defaultNodeSettings`, `compactDuration`, `nodeSubtitle`.

## 8. Verified vs unverified

**VERIFIED (byte-identical to game output, or user-confirmed in game):**
checksum algorithm; XXH3 implementation; move/add/delete payloads and checksums; new-node defaults for every
type; in-game load of exports after **move** and **add**; UPPER = slot 0, LOWER = slot 1; Graph 0 name.

**NOT yet tested in the game:** export after **delete**, **multi-node delete** (node order after several
swap-removes is a guess at what the game does), **link edits**, **channel edits**, **time edits**.

**Risks / UNKNOWN:**
- The ~1 KB **trailer** (runtime state) is not understood. If it refers to nodes by position/id, editing a graph
  that has saved state may desync it. All sample edits were in a graph with no saved state. Test carefully on a copy.
- World Object refs: mostly resolvable to player-given names via `entity_chunk00` (section 4.5a); some are absent.
- Graph names/ids/timestamps and existing nodes' types are not editable.
- Preset identity of `game_settings` (Hard vs Custom) unknown.

## 9. Testing

Shipped (`tests/`, run with `tsx`, no Angular):
- `xxh3.check.ts` + `xxh3.vectors.json` — 851 reference vectors.
- `core.check.ts <ksd>` — parse, checksums, byte-identical round-trip, edited rebuild, corruption rejection.
- `model.check.ts <world0.ksd>` — 142 checks; hard-coded to the *original* save's graphs.
- `gamefiles.check.ts base moved add delete` — 18 checks incl. randomized stress.
- `simulator.check.ts` — 53 behaviour checks of the Test-mode simulator (self-contained).
- `worldobjects.check.ts <ksd>...` — World Object lookup; checks EC2 Switch 1–8 when "Encounter 2 Passcode" exists.
  Needs game-written saves: base = original with an empty graph renamed "test" + one of every node;
  `moved` = two nodes moved; `add` = one AND added to "test"; `delete` = one AND deleted.

**Lost in the hand-off (not in the zip):** two component-level suites — `ui.check.ts` (66 checks, app state
logic) and `canvas.check.ts` (55 checks, hit testing/linking) — which ran against a small stand-in for
Angular's signal API. Also the strict-`tsc` stub config and the template identifier linter. Recreate them as
proper Angular TestBed/Vitest tests once the app builds. Worth covering: slot hit-testing (input ports first,
then body), drag-to-link onto UPPER vs LOWER, 200-node cap in the palette, undo/redo around add/delete,
export self-verification failure path.

## 10. Known gotchas / things to do first

1. `npm install && npm run build`; fix any template/type errors (templates were never compiled; only linted).
2. Template note: nested `@if` is used instead of `@else if (...; as alias)` because alias syntax was uncertain.
3. In tests, avoid top-level `await` (CommonJS) — wrap in an async IIFE; avoid duplicate `const` names in
   a shared scope (esbuild errors).
4. `Uint8Array<ArrayBuffer>` return types are used for `hexToBytes/serializeLogicPayload/buildKsd` (TS 5.7+).
5. Always test exports on a **copy** of a save; keep the original.

## 11. Python tools (`tools/`)

- `parse_ksd_logic.py` — original minimal Sparkworks extractor (graphs → JSON). It skips 18 bytes
  (14-byte chunk header + 4-byte length field) and ignores the trailer; prefer the others for anything else.
- `ksd_to_json.py` — whole container → human-readable JSON (container, chunk directory, logic, custom_strings,
  partial world_metadata; `--dump-raw`; zstd via `compression.zstd`/`zstandard`/`pyzstd`).
- `ksd_game_settings.py` — decode/encode `game_settings` (`<ksd> [more.ksd] [--json out.json]`), round-trips exactly.
- `parseKsdLogic.ts` — dependency-free TS port of the first extractor.
- Sample outputs: `samples/` (`world0_full.json`, `sparkworks_graphs.json`, `game_settings.json`,
  `preview_dungeon_door.png`).

## 12. Possible next steps

- Compile/run the Angular app; fix issues; add real component tests.
- In-game test of delete / link / channel / time edits, then record results in section 8 and the README.
- Understand the trailer (diff saves before/after play in a graph with state).
- Optional: read-only or editable `game_settings` panel (schema already in `tools/ksd_game_settings.py`;
  port to TS and rewrite that chunk + checksum the same way as `logic`).
