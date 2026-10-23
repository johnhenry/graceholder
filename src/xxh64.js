// XXH64 as published (https://github.com/Cyan4973/xxHash, XXH64 spec v0.8).
// BigInt implementation: synchronous, dependency free, identical in Node and browsers.
// FROZEN: any deviation from the published algorithm is a bug (docs/design.md 2.1).

const M = 0xffffffffffffffffn;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;

function read64(b, i) {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]);
  return v;
}

function read32(b, i) {
  return BigInt((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0);
}

function round(acc, input) {
  acc = (acc + input * P2) & M;
  acc = rotl(acc, 31);
  return (acc * P1) & M;
}

function mergeRound(acc, val) {
  acc ^= round(0n, val);
  return (acc * P1 + P4) & M;
}

/**
 * @param {Uint8Array} bytes
 * @param {bigint} [seed]
 * @returns {bigint} unsigned 64-bit hash
 */
export function xxh64(bytes, seed = 0n) {
  const len = bytes.length;
  let i = 0;
  let h;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M;
    let v2 = (seed + P2) & M;
    let v3 = seed & M;
    let v4 = (seed - P1) & M;
    const limit = len - 32;
    do {
      v1 = round(v1, read64(bytes, i));
      v2 = round(v2, read64(bytes, i + 8));
      v3 = round(v3, read64(bytes, i + 16));
      v4 = round(v4, read64(bytes, i + 24));
      i += 32;
    } while (i <= limit);
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + P5) & M;
  }
  h = (h + BigInt(len)) & M;
  while (i + 8 <= len) {
    h ^= round(0n, read64(bytes, i));
    h = (rotl(h, 27) * P1 + P4) & M;
    i += 8;
  }
  if (i + 4 <= len) {
    h ^= (read32(bytes, i) * P1) & M;
    h = (rotl(h, 23) * P2 + P3) & M;
    i += 4;
  }
  while (i < len) {
    h ^= (BigInt(bytes[i]) * P5) & M;
    h = (rotl(h, 11) * P1) & M;
    i++;
  }
  h ^= h >> 33n;
  h = (h * P2) & M;
  h ^= h >> 29n;
  h = (h * P3) & M;
  h ^= h >> 32n;
  return h;
}
