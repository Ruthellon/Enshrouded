# Enshrouded Sparkworks Editor

An Angular app that opens an Enshrouded world file (`world0.ksd`), shows its Sparkworks graphs, lets you move,
add and delete nodes and edit the connections between them, and exports a new `.ksd`.

Everything runs in your browser. The file is never uploaded anywhere.

> **Always keep a backup of your original world file** before replacing it. The format was reverse-engineered from
> save files, not documented by the game. See [What is and is not verified](#what-is-and-is-not-verified).

## Run it

Requires Node 20.19+ or 22.12+ (Angular 20).

```bash
npm install
npm start          # serves http://localhost:4200
npm run build      # production build in dist/
```

## Use it

1. Drop `world0.ksd` on the page (or click to choose it).
2. Pick a graph on the left. Graphs show their in-game names (read from the file). Graphs with no nodes are disabled.
3. **Move tool:** drag a node to move it, drag the background to pan, scroll to zoom. Click a link or node to
   inspect it. You can also type exact x / y values in the right-hand panel.
   Every node shows its connection slots: **inputs on the left, the output on the right**. A Timed Trigger, D
   Flip-Flop or Toggle has two input slots (upper and lower), most other nodes have one input slot that takes the
   links the game allows, and Save Signal and Global Reset have no output slot while Use Signal, On and Off have no
   input slot.
4. **Add tool:** pick a node type in the "Add node" palette, then click the empty canvas to place it. A graph can
   hold at most 200 nodes (Enshrouded's limit); the sidebar shows the count. Select a node to **Duplicate** it (links
   are not copied) or **Delete node** (its links are removed with it; `Delete` key also works).
5. **Linking:** drag from a node's **output slot** (right edge) to an **input slot** (left edge) of another node. The
   slot you drop on decides which input is used, so dropping on a Timed Trigger's lower slot makes a LOWER link.
   Dropping on a node's body instead uses the first free input. You can also click an output slot and then click an
   input slot. This works in any tool; the **Connect tool** additionally lets you drag from the node body. `Esc`
   cancels.
6. Select a link to reverse it, switch it between UPPER and LOWER (two-input nodes only), or delete it
   (`Delete` key also works).
7. Select a Save or Use Signal to change its channel (1-32). Select a Hold, Clock or Timed Trigger to change its
   time values (`min:sec:ms`, `0:0:000` to `10:0:000`, or plain seconds such as `1.5`).
8. `Ctrl+Z` / `Ctrl+Y` undo and redo. "Revert this graph" restores the graph as loaded.
9. **Export .ksd** downloads the new file. Before offering the download, the app rebuilds the file, reads it back, and
   checks both that it matches what you see and that every chunk checksum is valid. If either check fails, nothing is
   downloaded.

Logic gates are drawn as their usual symbols (AND, OR, NOT, NAND, XOR); every other node is a rectangle showing its
type name, with a second line for its channel, times or object. Nodes are large by default. Use "Node size" in the
sidebar to scale them (40% to 180%); large graphs are easier to read at a smaller size or when zoomed in.

Visual cues: node colour = category (gray World Object, pink Time Node, blue Logic Operator, purple Saving State);
yellow dashed ring = moved or changed node; green dashed link or ring = new; orange link = into a LOWER connection;
white = selected. Orange slots and links are LOWER inputs; a green slot lights up while you drag a link over it.

### Connection rules

By default the editor enforces the game's rules when you add or change a link: no inputs into Use Signal, On or
Off; no outputs from Save Signal or Global Reset; one input on Hold, Clock, NOT, Flank, Save Signal and Global
Reset; one input each on the UPPER and LOWER connection of D Flip-Flop, Toggle and Timed Trigger; any number into
AND, OR, NAND, XOR and World Objects; only one Save Signal per channel per graph; and no Use Signal linked directly
to a Save Signal of the same channel. Untick "Enforce Sparkworks connection rules" to override. The "Rule check"
panel lists any problems already present in a graph. The 200-node limit cannot be switched off.

## How exporting works

Only the `logic` chunk (the Sparkworks data) is rewritten. All other chunks are copied byte for byte. Because the
logic chunk changes length when you add or remove nodes or links, the app also updates the file-size field, the footer
position, the logic chunk's directory size, and the directory offsets of the chunks stored after it.

**Checksums.** Each chunk's directory entry stores a checksum, and the game rejects a file whose checksums do not
match ("corrupted"). It is the **low 32 bits of XXH3-64 (seed 0) over the chunk's complete bytes, including its
14-byte header**. The editor recomputes it for the rewritten chunk (`src/app/ksd/xxh3.ts`, a plain TypeScript
implementation). If you load a file whose checksums are already wrong, for example one exported by an older version of
this editor, a warning says so.

Exporting with no edits produces a file identical to the input, byte for byte.

### Matching the game

New nodes are appended to the end of a graph's node list and deleting a node moves the last node into its slot,
because that is what the game does. Graph timestamps are left alone (the game rewrites them itself when it loads a
graph), as is the runtime-state table stored after the graph list.

## What is and is not verified

Verified against saves the game itself wrote (a base save, and the same save after the game moved two nodes, added a
node, and deleted a node):

* The checksum algorithm: it matches all 85 chunk entries across five game-written files.
* The XXH3 implementation matches the reference xxHash library on 851 test inputs.
* For each of the three edits, applying the same edit with this editor produces a logic chunk that is **identical byte
  for byte** to the game's, and the directory checksum it computes equals the one the game wrote.
* Randomised edit sessions on each of those files rebuild into files with valid structure and checksums.
* The stored layout of every node type, including the defaults the game gives a new node (Hold and Clock 0.5 s, Timed
  Trigger delay 1 s and interval 0, Save/Use channel 1, a World Object with no object assigned).

Confirmed in the game itself:

* Exporting after **moving nodes** and after **adding nodes** produces a file the game loads.
* **UPPER = input slot 0, LOWER = input slot 1.**

Not yet tested in the game:

* Exporting after **deleting nodes** (the editor reproduces the game's own delete byte for byte, but the game has not
  yet been shown an exported file), **changing links**, **changing a Save/Use channel** or **a time value**.
* **The runtime-state table after the graph list** (about 1 KB; it holds values that change as you play and records
  for some graphs) is preserved verbatim. It is not understood, so if it refers to nodes by position, editing a
  graph that has saved state could leave it out of step. The sample edits were all in a graph with no saved state.
* World Objects: a new or duplicated one has no object assigned, so link it to an object inside the game. Existing
  objects show only a reference that cannot be turned into a name.
* Graph names and ids, node types of existing nodes, and timestamps are not editable.

## Project layout

```
src/app/ksd/ksd-core.ts          read/write the container and logic chunk, checksums (no Angular)
src/app/ksd/xxh3.ts              XXH3-64 (no Angular)
src/app/ksd/sparkworks-types.ts  node types, colours, rules, channel + time encoding, new-node defaults (no Angular)
src/app/ksd/node-shapes.ts       node sizes, logic-gate symbols and where each node's slots are (no Angular)
src/app/ksd/graph-model.ts       edit operations, rule checks, change summary, undo/redo (no Angular)
src/app/ksd/graph-geometry.ts    pan/zoom/fit, link curves, hit testing (no Angular)
src/app/graph-canvas/            SVG canvas component (pointer handling)
src/app/node-icon/               small node picture used in the legend and palette
src/app/app.*                    shell: upload, graph list, tools, details panel, export
tests/                           checks you can run against your own files
```

The `ksd/` files are plain TypeScript, so they can be reused outside Angular.

## Tests

These need your save files and `tsx` (installed by `npm install`):

```bash
npx tsx tests/xxh3.check.ts                                   # XXH3 vs reference vectors (self-contained)
npx tsx tests/core.check.ts  path/to/any-save.ksd             # parse, checksums, byte-identical round trip, edited rebuild
npx tsx tests/model.check.ts path/to/world0.ksd               # edits, rules, limits, history, geometry (written for the original save)
npx tsx tests/gamefiles.check.ts base.ksd moved.ksd add.ksd delete.ksd   # my writer vs. the game's own output
```

`gamefiles.check.ts` takes four saves written by the game: a base, and that same save after the game moved some
nodes, after it added one node, and after it deleted one node.

## Format notes (as understood)

```
Container  'SV2C' ... footer = 40 zero bytes + 20-byte entries <rel_name_off, name_len, offset, size, checksum>
           checksum = low 32 bits of XXH3-64 (seed 0) over the chunk's complete bytes
Chunk      'S2BH', u32 version, u16 type (high byte 1 = zstd), u32 schema version, payload
logic      u32 byte length, u32 version(6), u32 graph count, then per graph:
             13-byte id, u64 timestamp, u32 node count,
             nodes: u32 id, f32 x, f32 y, u8 type, u8 hasExtra, extra bytes
                    (extra length by type: 0->4, 1->8, 2->8, 10->16, 11->1, 12->1)
             u32 edge count, edges: u32 from, u32 to, u16 flag
           then a runtime-state table (preserved verbatim)

Extra bytes by node type
  0 World Object   4 bytes object reference, or none when no object is assigned
  1 Hold           8 bytes   u64 nanoseconds: delay            (new node: 0.5 s)
  2 Clock          8 bytes   u64 nanoseconds: interval         (new node: 0.5 s)
  10 Timed Trigger 16 bytes  u64 ns delay, u64 ns interval     (new node: 1 s, 0)
  11 Save / 12 Use 1 byte    channel - 1                        (new node: channel 1)
  all other types  none

Link flag high byte = input connection on the target (0 = upper / only, 1 = lower)

Graph names: a graph's 13-byte id ends in an 8-byte key that is also a key in the 'custom_strings' chunk
  (u32 count, then count x [8-byte key, u32 length, UTF-8 text]); that entry is the graph's name.
```
