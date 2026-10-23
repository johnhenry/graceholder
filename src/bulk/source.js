// Serialisers return a sync generator for a sync source and an async generator for an async-only one.
import { GraceholderError } from "../errors.js";

export const isSync = (source) => source != null && typeof source[Symbol.iterator] === "function";
export const isAsync = (source) => source != null && typeof source[Symbol.asyncIterator] === "function";

/** Map every item to a string (or to nothing), keeping the sync/async nature of the source. */
/**
 * @param {any} source
 * @param {(item: any) => string} fn
 */
export function mapSource(source, fn) {
  if (isSync(source)) {
    return (function* () {
      for (const item of source) yield fn(item);
    })();
  }
  if (isAsync(source)) {
    return (async function* () {
      for await (const item of source) yield fn(item);
    })();
  }
  throw new GraceholderError("bad-options", "the source must be an iterable or an async iterable of items, for example a stream()");
}
