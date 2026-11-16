#!/usr/bin/env python3
"""
Decode the "game_settings" chunk of an Enshrouded .ksd world file.

Usage:
    python ksd_game_settings.py world0.ksd [more.ksd ...] [--json out.json]

The chunk is a packed, unpadded run of 38 values in the same order as the game's documented
`gameSettings` keys (Enshrouded 1.0 server readme): 4-byte little-endian floats, single bytes
(booleans and enums), and 8-byte unsigned integers holding nanoseconds.

How sure is each part?
  * Layout and order: certain. The decoder re-encodes what it decoded and checks that it gets
    back the identical bytes, and it checks that exactly 128 bytes are used.
  * Names: taken from the game's documented key order; the types line up one for one and the
    values that are documented defaults (e.g. 600000000000 ns, 0.5 for weapon recycling) land on
    the right slots.
  * Enum names: an enum is stored as its position in the game's documented option list. Every enum
    in the sample that has a documented default decodes to that default, which supports this.
"""
import json
import struct
import sys

# (key, kind, options)   kind: f32 | bool | ns | enum | int
SCHEMA = [
    ("playerHealthFactor", "f32", None),
    ("playerManaFactor", "f32", None),
    ("playerStaminaFactor", "f32", None),
    ("playerBodyHeatFactor", "f32", None),
    ("playerDivingTimeFactor", "f32", None),
    ("enableDurability", "bool", None),
    ("enableStarvingDebuff", "bool", None),
    ("foodBuffDurationFactor", "f32", None),
    ("fromHungerToStarving", "ns", None),
    ("shroudTimeFactor", "f32", None),
    ("tombstoneMode", "enum", ["AddBackpackMaterials", "Everything", "NoTombstone"]),
    ("enableGliderTurbulences", "bool", None),
    ("weatherFrequency", "enum", ["Disabled", "Rare", "Normal", "Often"]),
    ("fishingDifficulty", "enum", ["VeryEasy", "Easy", "Normal", "Hard", "VeryHard"]),
    ("miningDamageFactor", "f32", None),
    ("plantGrowthSpeedFactor", "f32", None),
    ("resourceDropStackAmountFactor", "f32", None),
    ("factoryProductionSpeedFactor", "f32", None),
    ("perkUpgradeRecyclingFactor", "f32", None),
    ("perkCostFactor", "f32", None),
    ("experienceCombatFactor", "f32", None),
    ("experienceMiningFactor", "f32", None),
    ("experienceExplorationQuestsFactor", "f32", None),
    ("randomSpawnerAmount", "enum", ["Few", "Normal", "Automatic", "Many", "Extreme"]),
    ("aggroPoolAmount", "enum", ["Few", "Normal", "Many", "Extreme"]),
    ("enemyDamageFactor", "f32", None),
    ("enemyHealthFactor", "f32", None),
    ("enemyStaminaFactor", "f32", None),
    ("enemyPerceptionRangeFactor", "f32", None),
    ("bossDamageFactor", "f32", None),
    ("bossHealthFactor", "f32", None),
    ("threatBonus", "f32", None),
    ("pacifyAllEnemies", "bool", None),
    ("tamingStartleRepercussion", "enum", ["KeepProgress", "LoseSomeProgress", "LoseAllProgress"]),
    ("dayTimeDuration", "ns", None),
    ("nightTimeDuration", "ns", None),
    ("curseModifier", "enum", ["Easy", "Normal", "Hard"]),
    ("flameLevelFogRemoval", "int", None),
]

# The game's "Default" difficulty preset (Enshrouded 1.0).
DEFAULTS = {
    "playerHealthFactor": 1, "playerManaFactor": 1, "playerStaminaFactor": 1, "playerBodyHeatFactor": 1,
    "playerDivingTimeFactor": 1, "enableDurability": True, "enableStarvingDebuff": False,
    "foodBuffDurationFactor": 1, "fromHungerToStarving": 600_000_000_000, "shroudTimeFactor": 1,
    "tombstoneMode": "AddBackpackMaterials", "enableGliderTurbulences": True, "weatherFrequency": "Normal",
    "fishingDifficulty": "Normal", "miningDamageFactor": 1, "plantGrowthSpeedFactor": 1,
    "resourceDropStackAmountFactor": 1, "factoryProductionSpeedFactor": 1, "perkUpgradeRecyclingFactor": 0.5,
    "perkCostFactor": 1, "experienceCombatFactor": 1, "experienceMiningFactor": 1,
    "experienceExplorationQuestsFactor": 1, "randomSpawnerAmount": "Automatic", "aggroPoolAmount": "Normal",
    "enemyDamageFactor": 1, "enemyHealthFactor": 1, "enemyStaminaFactor": 1, "enemyPerceptionRangeFactor": 1,
    "bossDamageFactor": 1, "bossHealthFactor": 1, "threatBonus": 1, "pacifyAllEnemies": False,
    "tamingStartleRepercussion": "LoseSomeProgress", "dayTimeDuration": 1_800_000_000_000,
    "nightTimeDuration": 720_000_000_000, "curseModifier": "Normal", "flameLevelFogRemoval": 11,
}

SIZE = {"f32": 4, "bool": 1, "ns": 8, "enum": 1, "int": 1}
PAYLOAD_SIZE = sum(SIZE[k] for _, k, _ in SCHEMA)  # 128


def read_chunk(path, name="game_settings"):
    d = open(path, "rb").read()
    if d[:4] != b"SV2C":
        raise SystemExit(f"{path}: not a .ksd file")
    footer, count = struct.unpack_from("<II", d, 0x28)
    base = footer + 40
    for i in range(count):
        rel, nlen, off, size, _crc = struct.unpack_from("<5I", d, base + 20 * i)
        if d[base + 20 * i + rel: base + 20 * i + rel + nlen].decode() == name:
            chunk = d[off: off + size]
            if chunk[:4] != b"S2BH":
                raise SystemExit(f"{path}: bad chunk header")
            return chunk[14:]  # payload after the 14-byte chunk header
    raise SystemExit(f"{path}: no '{name}' chunk")


def decode(payload):
    if len(payload) != PAYLOAD_SIZE:
        raise ValueError(f"expected {PAYLOAD_SIZE} bytes, found {len(payload)}")
    out, pos = {}, 0
    for key, kind, opts in SCHEMA:
        if kind == "f32":
            v = round(struct.unpack_from("<f", payload, pos)[0], 6)
        elif kind == "bool":
            if payload[pos] > 1:
                raise ValueError(f"{key}: boolean byte is {payload[pos]}")
            v = bool(payload[pos])
        elif kind == "ns":
            v = struct.unpack_from("<Q", payload, pos)[0]
        elif kind == "enum":
            i = payload[pos]
            if i >= len(opts):
                raise ValueError(f"{key}: value {i} is outside the documented options {opts}")
            v = opts[i]
        else:
            v = payload[pos]
        out[key] = v
        pos += SIZE[kind]
    return out


def encode(values):
    out = bytearray()
    for key, kind, opts in SCHEMA:
        v = values[key]
        if kind == "f32":
            out += struct.pack("<f", v)
        elif kind == "bool":
            out.append(1 if v else 0)
        elif kind == "ns":
            out += struct.pack("<Q", v)
        elif kind == "enum":
            out.append(opts.index(v))
        else:
            out.append(v)
    return bytes(out)


def pretty(key, kind, v):
    if kind == "f32":
        return f"{v:g}  ({v * 100:g}%)"
    if kind == "ns":
        s = v / 1e9
        return f"{v}  ({s / 60:g} min)"
    if kind == "bool":
        return "on" if v else "off"
    return str(v)


def main():
    args = sys.argv[1:]
    js = None
    if "--json" in args:
        i = args.index("--json")
        js = args[i + 1]
        del args[i: i + 2]
    if not args:
        raise SystemExit(__doc__)

    decoded = {}
    for path in args:
        payload = read_chunk(path)
        values = decode(payload)
        assert encode(values) == payload, "re-encoding did not reproduce the original bytes"
        decoded[path] = (payload, values)

    first = args[0]
    payload, values = decoded[first]
    print(f"{first}: {len(payload)} bytes decoded into {len(SCHEMA)} settings; re-encoding reproduces the bytes exactly.\n")
    for key, kind, _ in SCHEMA:
        mark = " " if values[key] == DEFAULTS[key] else "*"
        print(f" {mark} {key:36s} {pretty(key, kind, values[key])}")
    changed = [k for k, _, _ in SCHEMA if values[k] != DEFAULTS[k]]
    print(f"\n* = differs from the game's Default preset ({len(changed)} of {len(SCHEMA)}).")

    if len(args) > 1:
        print()
        for path in args[1:]:
            other = decoded[path][1]
            diff = [k for k in values if values[k] != other[k]]
            print(f"{path}: " + ("identical settings" if not diff else "differs in " + ", ".join(f"{k} ({values[k]} -> {other[k]})" for k in diff)))
    if js:
        json.dump({"file": first, "settings": values, "differs_from_default": changed}, open(js, "w"), indent=2)
        print(f"\nwrote {js}")


if __name__ == "__main__":
    main()
