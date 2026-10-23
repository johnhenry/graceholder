// Argument handling: canonical JSON, identifying arguments and collection keys
// (docs/design.md 3.1, 3.3). FROZEN at 1.0.0.

export const PAGING_ARGS = new Set(["first", "last", "after", "before", "offset", "limit", "skip", "take", "page", "pageSize", "perPage", "cursor"]);
/** Identifying argument names, in priority order. */
export const ID_ARGS = ["id", "key", "slug", "uuid", "email", "username", "handle", "sku"];
const COMPOSITE_SEP = "\x1e";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const keyText = (v) => (typeof v === "string" ? v : canonicalJson(v));

/**
 * The entity key selected by identifying arguments, or undefined.
 * @param {Record<string, any>} args
 * @param {string[]} [keyArgs] explicit (possibly composite) identifying argument names
 */
export function entityKeyFromArgs(args, keyArgs) {
  if (keyArgs && keyArgs.length) {
    const parts = [];
    for (const name of [...keyArgs].sort()) {
      if (args[name] === undefined || args[name] === null) return undefined;
      parts.push(keyText(args[name]));
    }
    return parts.join(COMPOSITE_SEP);
  }
  for (const name of ID_ARGS) if (args[name] !== undefined && args[name] !== null) return keyText(args[name]);
  return undefined;
}

/** Canonical JSON of the non-paging arguments, or "" when there are none. */
export function argsKeyOf(args) {
  const rest = {};
  for (const [k, v] of Object.entries(args)) if (!PAGING_ARGS.has(k) && v !== undefined) rest[k] = v;
  return Object.keys(rest).length ? canonicalJson(rest) : "";
}
