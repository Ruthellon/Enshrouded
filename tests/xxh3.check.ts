import { readFileSync } from 'node:fs';
import { xxh3_64, xxh3Low32 } from '../src/app/ksd/xxh3.ts';

const data = JSON.parse(readFileSync(new URL('./xxh3.vectors.json', import.meta.url), 'utf8')) as { vectors: { len: number; seed: number; hash: string }[] };
const M = 0xffffffff;
function gen(n: number, seed: number): Uint8Array {
  let s = (Math.imul(seed, 2654435761) + 12345) >>> 0;
  if (s === 0) s = 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}
let bad = 0;
const badLens: number[] = [];
for (const v of data.vectors) {
  const got = xxh3_64(gen(v.len, v.seed)).toString(16).padStart(16, '0');
  if (got !== v.hash) { bad++; if (badLens.length < 10) badLens.push(v.len); }
}
console.log(`${bad === 0 ? 'PASS' : 'FAIL'}  XXH3-64 matches the reference library on ${data.vectors.length - bad} of ${data.vectors.length} inputs (lengths 0..700 plus large)`);
if (bad) console.log('  first failing lengths:', badLens);
const known = xxh3_64(new Uint8Array(0)) === 0x2d06800538d394c2n;
console.log(`${known ? 'PASS' : 'FAIL'}  XXH3-64 of empty input is the published value 2d06800538d394c2`);
const lowOk = xxh3Low32(gen(51, 1)) === Number(xxh3_64(gen(51, 1)) & BigInt(M));
console.log(`${lowOk ? 'PASS' : 'FAIL'}  xxh3Low32 is the low 32 bits`);
process.exit(bad || !known || !lowOk ? 1 : 0);
