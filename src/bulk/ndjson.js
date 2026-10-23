// Newline-delimited JSON: one compact JSON document per item, each followed by "\n".
import { mapSource } from "./source.js";

/**
 * @param {Iterable<any>|AsyncIterable<any>} source items, for example a `stream()`
 * @returns {Generator<string>|AsyncGenerator<string>} lines (strings ending in "\n"); join them or pipe them to a writable
 */
export function toNDJSON(source) {
  return mapSource(source, (item) => `${JSON.stringify(item === undefined ? null : item)}\n`);
}
