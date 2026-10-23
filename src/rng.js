// SplitMix64 and the frozen draw helpers (docs/design.md 2.3).
// A Stream is local to ONE key: it is consumed only by that value's generator.

const M = 0xffffffffffffffffn;
const GAMMA = 0x9e3779b97f4a7c15n;
const TWO64 = 1n << 64n;

/**
 * One SplitMix64 step.
 * @param {bigint} state
 * @returns {[bigint, bigint]} [output, nextState]
 */
export function splitmix64Next(state) {
  const s = (state + GAMMA) & M;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  return [z ^ (z >> 31n), s];
}

export class SplitMix64 {
  /** @param {bigint} state */
  constructor(state) {
    this.state = state & M;
  }

  /** @returns {bigint} next unsigned 64-bit output */
  next() {
    const [out, s] = splitmix64Next(this.state);
    this.state = s;
    return out;
  }
}

/**
 * Unbiased integer in [lo, hi] using rejection sampling over u64 draws:
 * a draw is accepted only when it is below the largest multiple of the range
 * that fits in 2^64. At least one draw is always consumed.
 * @param {() => bigint} next
 */
export function intFrom(next, lo, hi) {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo) {
    throw new RangeError(`int(${lo}, ${hi}): need safe integers with lo <= hi`);
  }
  const range = BigInt(hi) - BigInt(lo) + 1n;
  if (range > 1n << 53n) throw new RangeError(`int(${lo}, ${hi}): range exceeds 2^53`);
  const limit = TWO64 - (TWO64 % range);
  for (;;) {
    const u = next();
    if (u < limit) return Number(BigInt(lo) + (u % range));
  }
}

export class Stream extends SplitMix64 {
  /** @returns {number} in [0, 1) with 53 bits of precision */
  float() {
    return Number(this.next() >> 11n) / 2 ** 53;
  }

  /** @returns {number} integer in [lo, hi], inclusive, unbiased */
  int(lo, hi) {
    return intFrom(() => this.next(), lo, hi);
  }

  /** @template T @param {readonly T[]} arr @returns {T} */
  pick(arr) {
    if (arr.length === 0) throw new RangeError("pick() of an empty array");
    return arr[this.int(0, arr.length - 1)];
  }

  /** @template T @param {ReadonlyArray<readonly [T, number]>} pairs @returns {T} */
  weighted(pairs) {
    let total = 0;
    for (const [, w] of pairs) total += w;
    if (!(total > 0)) throw new RangeError("weighted() needs a positive total weight");
    const x = this.float() * total;
    let acc = 0;
    for (const [v, w] of pairs) {
      acc += w;
      if (x < acc) return v;
    }
    return pairs[pairs.length - 1][0];
  }

  /** @returns {boolean} true with probability p */
  bool(p) {
    return this.float() < p;
  }
}
