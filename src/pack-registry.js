// Vocabulary packs (docs/design.md section 17). A pack is plain data plus functions:
//   { name, version, vocab, types?, generators(V, base), rules?(ctx), inherit?(typeName) }
// Packs live in separate modules (`@johnhenry/graceholder/packs/<name>`) so an application only
// ships the ones it imports. `registerPack` makes a pack addressable by name in `options.packs`.
import { GraceholderError } from "./errors.js";

const NAME = /^[a-z][a-z0-9-]*$/;
/** name -> pack object, for packs registered with registerPack */
const REGISTERED = new Map();
/** name -> the one pack object that has used this name (registered or passed directly) */
const SEEN = new Map();

const bad = (msg, hint) => new GraceholderError("bad-pack", msg, hint ? { hint } : undefined);

function validate(pack) {
  if (pack === null || typeof pack !== "object") throw bad("a pack must be an object");
  if (typeof pack.name !== "string" || !NAME.test(pack.name)) throw bad(`pack name must match ${NAME}, got ${JSON.stringify(pack.name)}`);
  if (typeof pack.generators !== "function") throw bad(`pack ${pack.name}: generators must be a function (V, base) => ({ name: (ctx) => value })`);
  if (pack.rules !== undefined && typeof pack.rules !== "function") throw bad(`pack ${pack.name}: rules must be a function`);
  if (pack.inherit !== undefined && typeof pack.inherit !== "function") throw bad(`pack ${pack.name}: inherit must be a function`);
  const seen = SEEN.get(pack.name);
  if (seen && seen !== pack) throw bad(`a different pack named ${JSON.stringify(pack.name)} is already in use`, "pack names are global; pick another name");
  SEEN.set(pack.name, pack);
}

/** Register a pack so `options.packs` can name it. Registering the same pack twice is fine. */
export function registerPack(pack) {
  validate(pack);
  REGISTERED.set(pack.name, pack);
  return pack;
}

/** Names of the registered packs. */
export function registeredPacks() {
  return [...REGISTERED.keys()];
}

/**
 * Resolve `options.packs` (names and/or pack objects) to pack objects, in order, without duplicates.
 * @returns {any[]}
 */
export function resolvePacks(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new GraceholderError("bad-options", "packs must be an array of pack names or pack objects");
  const out = [];
  for (const item of list) {
    let pack = item;
    if (typeof item === "string") {
      pack = REGISTERED.get(item);
      if (!pack) {
        throw new GraceholderError("unknown-pack", `unknown pack ${JSON.stringify(item)}`, {
          hint: `registered: ${registeredPacks().join(", ") || "(none)"}. Import it from "@johnhenry/graceholder/packs/${item}" and pass the object, or call registerPack()`,
        });
      }
    } else validate(item);
    if (!out.includes(pack)) out.push(pack);
  }
  return out;
}
