/**
 * XXH3 64-bit hash (xxHash 0.8.x), seed 0 and the default secret, in plain TypeScript.
 *
 * Why this exists: the .ksd chunk directory stores, for each chunk, the low 32 bits of
 * XXH3-64 computed over the chunk's complete bytes (14-byte header included). That was verified
 * against all 85 chunk entries of five game-written save files, and this implementation was
 * verified against the reference library on thousands of inputs (tests/xxh3.check.ts).
 *
 * Uses BigInt, which is plenty fast for save-file chunks. No dependencies.
 */

const MASK64 = (1n << 64n) - 1n;

const PRIME32_1 = 0x9e3779b1n;
const PRIME32_2 = 0x85ebca77n;
const PRIME32_3 = 0xc2b2ae3dn;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;
const PRIME_MX1 = 0x165667919e3779f9n;
const PRIME_MX2 = 0x9fb21c651e98df25n;

/** The 192-byte default secret (kSecret). */
const SECRET_HEX =
  'b8fe6c3923a44bbe7c01812cf721ad1cded46de9839097db7240a4a4b7b3671f' +
  'cb79e64eccc0e578825ad07dccff7221b8084674f743248ee03590e6813a264c' +
  '3c2852bb91c300cb88d0658b1b532ea371644897a20df94e3819ef46a9deacd8' +
  'a8fa763fe39c343ff9dcbbc7c70b4f1d8a51e04bcdb45931c89f7ec9d9787364' +
  'eac5ac8334d3ebc3c581a0fffa1363eb170ddd51b7f0da49d316552629d4689e' +
  '2b16be587d47a1fc8ff8b8d17ad031ce45cb3a8f95160428afd7fbcabb4b407e';

const SECRET: Uint8Array<ArrayBuffer> = (() => {
  const out = new Uint8Array(SECRET_HEX.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(SECRET_HEX.substr(i * 2, 2), 16);
  return out;
})();
const SECRET_VIEW = new DataView(SECRET.buffer);

const STRIPE_LEN = 64;
const SECRET_CONSUME_RATE = 8;
const SECRET_SIZE = SECRET.length; // 192
/** Smallest secret size the algorithm supports, used to place the last 16 bytes of 129-240 byte inputs. */
const SECRET_SIZE_MIN = 136;
const MIDSIZE_START_OFFSET = 3;
const MIDSIZE_LAST_OFFSET = 17;
const SECRET_LAST_ACC_START = 7;
const SECRET_MERGE_ACCS_START = 11;

const m = (x: bigint): bigint => x & MASK64;
const rotl64 = (x: bigint, r: bigint): bigint => m((x << r) | (x >> (64n - r)));

function swap64(x: bigint): bigint {
  let r = 0n;
  for (let i = 0n; i < 8n; i++) r = (r << 8n) | ((x >> (8n * i)) & 0xffn);
  return r;
}

/** Multiply two 64-bit values to 128 bits, then XOR the two halves together. */
function mul128Fold64(a: bigint, b: bigint): bigint {
  const p = a * b;
  return m(p) ^ (p >> 64n);
}

function xxh64Avalanche(h: bigint): bigint {
  h ^= h >> 33n;
  h = m(h * PRIME64_2);
  h ^= h >> 29n;
  h = m(h * PRIME64_3);
  return h ^ (h >> 32n);
}

function xxh3Avalanche(h: bigint): bigint {
  h ^= h >> 37n;
  h = m(h * PRIME_MX1);
  return h ^ (h >> 32n);
}

function rrmxmx(h: bigint, len: bigint): bigint {
  h ^= rotl64(h, 49n) ^ rotl64(h, 24n);
  h = m(h * PRIME_MX2);
  h ^= (h >> 35n) + len;
  h = m(h * PRIME_MX2);
  return h ^ (h >> 28n);
}

const sec64 = (o: number): bigint => SECRET_VIEW.getBigUint64(o, true);
const sec32 = (o: number): bigint => BigInt(SECRET_VIEW.getUint32(o, true));

function mix16B(v: DataView, inOff: number, secOff: number): bigint {
  const lo = v.getBigUint64(inOff, true);
  const hi = v.getBigUint64(inOff + 8, true);
  return mul128Fold64(lo ^ sec64(secOff), hi ^ sec64(secOff + 8));
}

function len0(): bigint {
  return xxh64Avalanche(sec64(56) ^ sec64(64));
}

function len1to3(v: DataView, len: number): bigint {
  const c1 = v.getUint8(0);
  const c2 = v.getUint8(len >> 1);
  const c3 = v.getUint8(len - 1);
  const combined = BigInt(((c1 << 16) | (c2 << 24) | c3 | (len << 8)) >>> 0);
  const bitflip = sec32(0) ^ sec32(4);
  return xxh64Avalanche(combined ^ bitflip);
}

function len4to8(v: DataView, len: number): bigint {
  const input1 = BigInt(v.getUint32(0, true));
  const input2 = BigInt(v.getUint32(len - 4, true));
  const bitflip = sec64(8) ^ sec64(16);
  const input64 = m(input2 + (input1 << 32n));
  return rrmxmx(input64 ^ bitflip, BigInt(len));
}

function len9to16(v: DataView, len: number): bigint {
  const bitflip1 = sec64(24) ^ sec64(32);
  const bitflip2 = sec64(40) ^ sec64(48);
  const lo = v.getBigUint64(0, true) ^ bitflip1;
  const hi = v.getBigUint64(len - 8, true) ^ bitflip2;
  const acc = m(BigInt(len) + swap64(lo) + hi + mul128Fold64(lo, hi));
  return xxh3Avalanche(acc);
}

function len17to128(v: DataView, len: number): bigint {
  let acc = m(BigInt(len) * PRIME64_1);
  if (len > 32) {
    if (len > 64) {
      if (len > 96) {
        acc = m(acc + mix16B(v, 48, 96));
        acc = m(acc + mix16B(v, len - 64, 112));
      }
      acc = m(acc + mix16B(v, 32, 64));
      acc = m(acc + mix16B(v, len - 48, 80));
    }
    acc = m(acc + mix16B(v, 16, 32));
    acc = m(acc + mix16B(v, len - 32, 48));
  }
  acc = m(acc + mix16B(v, 0, 0));
  acc = m(acc + mix16B(v, len - 16, 16));
  return xxh3Avalanche(acc);
}

function len129to240(v: DataView, len: number): bigint {
  let acc = m(BigInt(len) * PRIME64_1);
  const rounds = len >> 4;
  for (let i = 0; i < 8; i++) acc = m(acc + mix16B(v, 16 * i, 16 * i));
  acc = xxh3Avalanche(acc);
  for (let i = 8; i < rounds; i++) acc = m(acc + mix16B(v, 16 * i, 16 * (i - 8) + MIDSIZE_START_OFFSET));
  acc = m(acc + mix16B(v, len - 16, SECRET_SIZE_MIN - MIDSIZE_LAST_OFFSET));
  return xxh3Avalanche(acc);
}

// ---- inputs longer than 240 bytes: 8 parallel 64-bit accumulators over 64-byte stripes

function accumulate512(acc: bigint[], v: DataView, inOff: number, secOff: number): void {
  for (let i = 0; i < 8; i++) {
    const dataVal = v.getBigUint64(inOff + 8 * i, true);
    const dataKey = dataVal ^ sec64(secOff + 8 * i);
    acc[i ^ 1] = m(acc[i ^ 1] + dataVal);
    acc[i] = m(acc[i] + (dataKey & 0xffffffffn) * (dataKey >> 32n));
  }
}

function scramble(acc: bigint[], secOff: number): void {
  for (let i = 0; i < 8; i++) {
    let a = acc[i];
    a ^= a >> 47n;
    a ^= sec64(secOff + 8 * i);
    acc[i] = m(a * PRIME32_1);
  }
}

function mergeAccs(acc: bigint[], secOff: number, start: bigint): bigint {
  let result = start;
  for (let i = 0; i < 4; i++) {
    result = m(result + mul128Fold64(acc[2 * i] ^ sec64(secOff + 16 * i), acc[2 * i + 1] ^ sec64(secOff + 16 * i + 8)));
  }
  return xxh3Avalanche(result);
}

function hashLong(v: DataView, len: number): bigint {
  const acc: bigint[] = [PRIME32_3, PRIME64_1, PRIME64_2, PRIME64_3, PRIME64_4, PRIME32_2, PRIME64_5, PRIME32_1];
  const stripesPerBlock = (SECRET_SIZE - STRIPE_LEN) / SECRET_CONSUME_RATE; // 16
  const blockLen = STRIPE_LEN * stripesPerBlock; // 1024
  const blocks = Math.floor((len - 1) / blockLen);

  for (let n = 0; n < blocks; n++) {
    for (let s = 0; s < stripesPerBlock; s++) accumulate512(acc, v, n * blockLen + s * STRIPE_LEN, s * SECRET_CONSUME_RATE);
    scramble(acc, SECRET_SIZE - STRIPE_LEN);
  }
  const stripes = Math.floor((len - 1 - blockLen * blocks) / STRIPE_LEN);
  for (let s = 0; s < stripes; s++) accumulate512(acc, v, blocks * blockLen + s * STRIPE_LEN, s * SECRET_CONSUME_RATE);
  // last stripe always covers the final 64 bytes, even if that overlaps earlier data
  accumulate512(acc, v, len - STRIPE_LEN, SECRET_SIZE - STRIPE_LEN - SECRET_LAST_ACC_START);

  return mergeAccs(acc, SECRET_MERGE_ACCS_START, m(BigInt(len) * PRIME64_1));
}

/** XXH3 64-bit hash of `data` with seed 0 and the default secret. */
export function xxh3_64(data: Uint8Array): bigint {
  const len = data.length;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (len === 0) return len0();
  if (len <= 3) return len1to3(v, len);
  if (len <= 8) return len4to8(v, len);
  if (len <= 16) return len9to16(v, len);
  if (len <= 128) return len17to128(v, len);
  if (len <= 240) return len129to240(v, len);
  return hashLong(v, len);
}

/** The 32-bit value the .ksd chunk directory stores: the low 32 bits of XXH3-64. */
export function xxh3Low32(data: Uint8Array): number {
  return Number(xxh3_64(data) & 0xffffffffn);
}
