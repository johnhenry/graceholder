// Pieces shared by the client adapters (docs/design.md section 16, Adapters). Nothing here
// imports an optional peer dependency.
import { print } from "graphql";
import { createWorld } from "../world.js";
import { keyStream } from "../key.js";

const ADAPTER_KEYS = new Set(["world", "latency", "delay", "match", "fallback"]);

/**
 * The world an adapter answers from: the given `world`, or a new one built from the remaining
 * options (seed, spec, anchorDate, locale, strict, log, ...).
 */
export function resolveWorld(options = {}) {
  if (options.world) {
    if (typeof options.world.query !== "function") throw new TypeError("adapter option `world` must come from createWorld()");
    return options.world;
  }
  const worldOptions = {};
  for (const [k, v] of Object.entries(options)) if (!ADAPTER_KEYS.has(k)) worldOptions[k] = v;
  return createWorld(worldOptions);
}

/** The seed that keys latency: the world's own seed, so a world and its adapter agree. */
export function seedOf(world) {
  return world.export().seed;
}

const toRange = (latency) => {
  if (latency === undefined || latency === false || latency === null) return null;
  if (typeof latency === "number") return [latency, latency];
  if (Array.isArray(latency)) return [latency[0], latency[1]];
  if (typeof latency === "object") return [latency.min, latency.max];
  throw new TypeError("latency must be a number, [min, max] or { min, max }");
};

/**
 * Milliseconds of simulated latency for one request. It is a pure function of the seed and the
 * request (operation name, query text, variables): the same request always waits the same time.
 * @returns {number} 0 when latency is off
 */
export function latencyFor(latency, seed, { query, operationName, variables }) {
  const range = toRange(latency);
  if (!range) return 0;
  const [lo, hi] = range;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi < lo) {
    throw new RangeError("latency needs non-negative integers with min <= max");
  }
  if (lo === hi) return lo;
  const text = typeof query === "string" ? query : print(query);
  return keyStream({
    seed,
    scope: "a",
    typeName: "$adapter",
    entityKey: operationName ?? "",
    fieldName: "latency",
    subKeys: [text, JSON.stringify(variables ?? {})],
  }).int(lo, hi);
}

/** Wait `ms` (the injected `delay`, or setTimeout). Resolves at once for 0. */
export function wait(ms, delay) {
  if (delay) return Promise.resolve(delay(ms));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
