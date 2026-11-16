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
Semantics (shown as tooltips): D Flip-Flop — LOWER ON samples and stores UPPER, LOWER OFF holds; Toggle —
UPPER pulses toggle, LOWER resets to OFF; Timed Trigger — UPPER off→on waits `delay`, then ON for `interval`,
LOWER ON resets.

## 7. Architecture

```
src/app/ksd/ksd-core.ts          parse/serialize container + logic chunk, checksums, graph names, buildKsd
src/app/ksd/xxh3.ts              XXH3-64 (BigInt)   exports xxh3_64(data): bigint, xxh3Low32(data): number
src/app/ksd/sparkworks-types.ts  node table, colours, channels, durations, defaults, subtitles
src/app/ksd/node-shapes.ts       node geometry, gate symbols, slot (port) positions
src/app/ksd/graph-model.ts       immutable edit ops, rule checks, change summary, History<T>
src/app/ksd/graph-geometry.ts    viewport/zoom/fit, hit boxes, bezier link path
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
6. **Defaults for new nodes match what the game writes** (section 4.4); World Object has no object ref and must
   be linked in-game; duplicating a World Object produces an unassigned one; a duplicated Save Signal gets the
   lowest free channel; a new Use Signal takes the lowest channel that has a Save.
7. **Y axis**: the game's y-axis orientation was never confirmed, so the canvas has a "Flip Y" toggle.

### 7.2 Public API (signatures)

`ksd-core.ts`: `parseKsd(bytes) → ParsedKsd`, `buildKsd(parsed, logic) → Uint8Array`,
`serializeLogicPayload`, `parseLogicPayload`, `logicEquals`, `checksumMismatches`, `chunkChecksum`,
`readCustomStrings`, `graphKey`, `graphName`, `bytesToHex/hexToBytes/bytesEqual`, `KsdError`,
types `SparkNode {id,x,y,type,hasExtra,extra}`, `SparkEdge {from,to,flag}`,
`SparkGraph {graphId,timestampHex,nodes,edges}`, `LogicData {version,graphs,trailer}`.

`graph-model.ts`: `moveNode`, `addEdge`, `removeEdge`, `reverseEdge`, `setEdgeSlot`, `setChannel`,
`setDuration`, `insertNode`, `duplicateNode`, `deleteNode` (→ `{data, removedEdges, orphanedUses}`),
`newNodeId`, `autoSlot`, `structuralIssue`, `ruleIssue`, `connectionIssue`, `validateGraph`,
`summarizeChanges`, `edgeKey` (`from>to#flag`), `slotOf` (`flag>>8`), `withSlot`, `class History<T>`.

`sparkworks-types.ts`: `NODE_TYPES`, `typeInfo/typeName/typeColor/slotLabel`, `hasChannel/channelOf/channelExtra`,
`DURATION_FIELDS`, `readDurations/writeDuration/formatDuration/parseDuration`, `MAX_NODES_PER_GRAPH=200`,
`INSERTABLE_TYPES`, `defaultNodeSettings`, `compactDuration`, `nodeSubtitle`.

## 8. Verified vs unverified

**VERIFIED (byte-identical to game output, or user-confirmed in game):**
checksum algorithm; XXH3 implementation; move/add/delete payloads and checksums; new-node defaults for every
type; in-game load of exports after **move** and **add**; UPPER = slot 0, LOWER = slot 1; Graph 0 name.

**NOT yet tested in the game:** export after **delete**, **link edits**, **channel edits**, **time edits**.

**Risks / UNKNOWN:**
- The ~1 KB **trailer** (runtime state) is not understood. If it refers to nodes by position/id, editing a graph
  that has saved state may desync it. All sample edits were in a graph with no saved state. Test carefully on a copy.
- World Object refs (4 bytes) cannot be resolved to names (no match in the string table).
- Graph names/ids/timestamps and existing nodes' types are not editable.
- Preset identity of `game_settings` (Hard vs Custom) unknown.

## 9. Testing

Shipped (`tests/`, run with `tsx`, no Angular):
- `xxh3.check.ts` + `xxh3.vectors.json` — 851 reference vectors.
- `core.check.ts <ksd>` — parse, checksums, byte-identical round-trip, edited rebuild, corruption rejection.
- `model.check.ts <world0.ksd>` — 142 checks; hard-coded to the *original* save's graphs.
- `gamefiles.check.ts base moved add delete` — 18 checks incl. randomized stress.
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
