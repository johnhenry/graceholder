// @johnhenry/graceholder/fast-check: a fast-check arbitrary over seeds and scenario sets.
// fast-check is an OPTIONAL peer dependency; this subpath is the only module that imports it.
import * as fc from "fast-check";
import { graceholder } from "./index.js";
import { SCENARIOS, normalizeScenarios } from "./scenario.js";
import { GraceholderError } from "./errors.js";

const MAX_SEED = 0x7fffffff;

/** The options that decide what is generated; the arbitrary owns `seed`, `scenario` and `errors`. */
function baseOptions(options) {
  const { seeds, scenarios, seed, scenario, errors, ...rest } = options;
  if (seed !== undefined || scenario !== undefined || errors !== undefined) {
    throw new GraceholderError("bad-options", "graceholderArbitrary chooses seed, scenario and errors itself; use `seeds` and `scenarios` instead");
  }
  return rest;
}

/** Generate for one sample: the same call the arbitrary makes, so a printed `{ seed, scenarios }` reproduces. */
export function replay(query, sample, options = {}) {
  const { seed, scenarios = [] } = sample;
  const out = graceholder(query, { ...baseOptions(options), seed, scenario: scenarios, errors: "result" });
  return { seed, scenarios: [...scenarios], data: out.data ?? null, errors: out.errors ?? [] };
}

/**
 * An arbitrary of `{ seed, scenarios, data, errors }`.
 *
 * - `seeds`: an arbitrary of seeds (default: integers from 0, shrinking toward 0).
 * - `scenarios`: the scenarios that may be combined (default: all), or `false` / `[]` for none.
 *   The chosen set shrinks toward empty.
 * - every other option is passed to `graceholder()` (spec, packs, variables, ...).
 *
 * A counterexample is printed as `graceholder({ seed, scenarios })`, which is everything needed to
 * reproduce it with {@link replay} or `graceholder(query, { seed, scenario })`.
 *
 * @param {string|import("graphql").DocumentNode} query
 * @param {Record<string, any>} [options]
 */
export function graceholderArbitrary(query, options = {}) {
  const allowed = options.scenarios === false ? [] : normalizeScenarios(options.scenarios ?? SCENARIOS, (m) => new GraceholderError("bad-options", `scenarios: ${m}`)) ?? [];
  const seeds = options.seeds ?? fc.integer({ min: 0, max: MAX_SEED });
  const base = baseOptions(options);
  const sets = allowed.length ? fc.subarray(allowed) : fc.constant([]);
  // fail early (bad query, bad spec) instead of inside the first run
  graceholder(query, { ...base, seed: 0, scenario: [] });
  return fc.record({ seed: seeds, scenarios: sets }).map(({ seed, scenarios }) => {
    const sample = replay(query, { seed, scenarios }, base);
    Object.defineProperty(sample, fc.toStringMethod, {
      value: () => `graceholder(${JSON.stringify({ seed, scenarios })})`,
      enumerable: false,
    });
    return sample;
  });
}

export { SCENARIOS };
export default graceholderArbitrary;
