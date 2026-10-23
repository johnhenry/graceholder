// stream(): the root collection of a query as a lazy sync and async iterable.
import { planStream, windows } from "./plan.js";

/**
 * A lazily generated collection. Iterating generates one window of items at a time, so memory stays
 * bounded however many items are consumed. Every iteration starts again at the first item.
 */
export class Stream {
  /**
   * @param {any} query
   * @param {any} options
   * @param {any} [world]
   */
  constructor(query, options, world) {
    this.plan = planStream(query, options, world);
    /** what toSQL needs to plan the same stream again with entity keys */
    this.config = { query, options, world };
  }

  /** The response key of the streamed root field. */
  get field() {
    return this.plan.key;
  }

  /** Windows of items (arrays of at most `chunkSize`), lazily. */
  *chunks() {
    for (const w of windows(this.plan)) yield w.items;
  }

  *[Symbol.iterator]() {
    for (const w of windows(this.plan)) yield* w.items;
  }

  async *[Symbol.asyncIterator]() {
    for (const w of windows(this.plan)) {
      for (const item of w.items) yield item;
      await Promise.resolve(); // let other work run between windows
    }
  }
}

/**
 * The root collection of a query as a lazy iterable of items. Item k equals item k of the windowed
 * query `field(offset: k, first: 1)`.
 * @param {any} query
 * @param {any} [options]
 */
export function stream(query, options = {}) {
  return new Stream(query, options, undefined);
}

/** Used by createWorld().stream. */
export function streamWorld(query, options, world) {
  return new Stream(query, options, world);
}
