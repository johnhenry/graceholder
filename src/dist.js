// Distribution sampling (docs/design.md section 17). Every function draws only from the
// stream it is given (the per-value stream), so a value never depends on any other value.
// Only IEEE basic operations and src/detmath.js are used, so results are identical on every engine.
import { ln, exp, pow, cos, TWO_PI } from "./detmath.js";
import { GraceholderError } from "./errors.js";

export const DISTRIBUTIONS = Object.freeze(["uniform", "normal", "lognormal", "zipf", "powerlaw"]);

const badArgs = (name, msg) => new GraceholderError("bad-generator-args", `${name}: ${msg}`);

/** Standard normal by Box-Muller (the cosine branch); consumes exactly two floats. */
export function normal01(s) {
  const u1 = 1 - s.float(); // (0, 1]
  const u2 = s.float();
  return Math.sqrt(-2 * ln(u1)) * cos(TWO_PI * u2);
}

/** Truncated normal on [lo, hi] by rejection (at most 12 attempts, then clamped). */
function truncNormal(s, mu, sigma, lo, hi) {
  let x = mu;
  for (let i = 0; i < 12; i++) {
    x = mu + sigma * normal01(s);
    if (x >= lo && x <= hi) return x;
  }
  return Math.min(hi, Math.max(lo, x));
}

/** Inverse CDF of the density proportional to y^-alpha on [1, top]; u in [0, 1). */
export function boundedPowerInverse(u, alpha, top) {
  if (top <= 1) return 1;
  if (alpha === 1) return exp(u * ln(top));
  const a = 1 - alpha;
  return pow(1 + u * (pow(top, a) - 1), 1 / a);
}

/** Validate and read the distribution arguments shared by int, float and money. */
export function distArgs(name, args) {
  const dist = args.dist ?? "uniform";
  if (!DISTRIBUTIONS.includes(dist)) throw badArgs(name, `unknown dist ${JSON.stringify(dist)} (known: ${DISTRIBUTIONS.join(", ")})`);
  for (const k of ["mean", "sd", "mu", "sigma", "alpha", "s"]) {
    if (args[k] !== undefined && !Number.isFinite(args[k])) throw badArgs(name, `${k} must be a number`);
  }
  if (args.sd !== undefined && !(args.sd > 0)) throw badArgs(name, "sd must be positive");
  if (args.sigma !== undefined && !(args.sigma > 0)) throw badArgs(name, "sigma must be positive");
  if (args.alpha !== undefined && !(args.alpha > 0)) throw badArgs(name, "alpha must be positive");
  if (args.s !== undefined && !(args.s > 0)) throw badArgs(name, "s must be positive");
  return dist;
}

/**
 * A real number in [min, max] from the named distribution.
 *  - uniform: min + u (max - min)
 *  - normal: mean (default the midpoint), sd (default range / 6), truncated to [min, max]
 *  - lognormal: y = x - min + 1 in [1, range + 1]; ln y ~ N(mu, sigma) truncated to the support;
 *    defaults mu = 0.35 ln(range + 1), sigma = ln(range + 1) / 6.5 (median well below the middle, long right tail)
 *  - powerlaw: density proportional to y^-alpha on [1, range + 1] (default alpha 2), inverse CDF
 *  - zipf: only meaningful for integers, see {@link zipfRank}; here it is the same as powerlaw with exponent `s`
 */
export function sampleReal(s, dist, min, max, args = {}) {
  const range = max - min;
  switch (dist) {
    case "uniform":
      return min + s.float() * range;
    case "normal":
      return truncNormal(s, args.mean ?? min + range / 2, args.sd ?? range / 6, min, max);
    case "lognormal": {
      const top = ln(range + 1);
      const y = exp(truncNormal(s, args.mu ?? 0.35 * top, args.sigma ?? top / 6.5, 0, top));
      return Math.min(max, min + (y - 1));
    }
    case "powerlaw":
      return Math.min(max, min + (boundedPowerInverse(s.float(), args.alpha ?? 2, range + 1) - 1));
    default:
      return Math.min(max, min + (boundedPowerInverse(s.float(), args.s ?? 1.1, range + 1) - 1));
  }
}

/**
 * Integer in [min, max] from the named distribution. zipf is the bounded power law discretised
 * by flooring: rank k in 1..N has probability proportional to k^(1-s) - (k+1)^(1-s), and the
 * result is min + k - 1, so the smallest value is the most likely.
 */
export function sampleInt(s, dist, min, max, args = {}) {
  if (dist === "zipf") {
    const n = max - min + 1;
    const y = boundedPowerInverse(s.float(), args.s ?? 1.1, n + 1);
    return min + Math.min(n, Math.floor(y)) - 1;
  }
  return Math.min(max, Math.max(min, Math.round(sampleReal(s, dist, min, max, args))));
}
