// Key string (scheme gh1) -> hash -> local stream. FROZEN at 1.0.0 (docs/design.md 2.2).
import { xxh64 } from "./xxh64.js";
import { Stream } from "./rng.js";

export const KEY_SCHEME = "gh1";
const SEP = "\x1f";
const SCOPES = new Set(["e", "l", "p", "a"]);
const encoder = new TextEncoder();

const clean = (v) => String(v).replaceAll(SEP, "�");

/**
 * @param {{ seed: string|number, scope: "e"|"l"|"p"|"a", typeName: string, entityKey: string,
 *           fieldName: string, subKeys?: Array<string|number> }} p
 */
export function keyString(p) {
  if (!SCOPES.has(p.scope)) throw new RangeError(`unknown key scope ${JSON.stringify(p.scope)}`);
  const parts = [KEY_SCHEME, p.seed, p.scope, p.typeName, p.entityKey, p.fieldName, ...(p.subKeys ?? [])];
  return parts.map(clean).join(SEP);
}

/** @returns {bigint} XXH64 (seed 0) of the UTF-8 key string */
export function hashKey(p) {
  return xxh64(encoder.encode(keyString(p)), 0n);
}

/** @returns {Stream} the SplitMix64 stream for this key */
export function keyStream(p) {
  return new Stream(hashKey(p));
}
