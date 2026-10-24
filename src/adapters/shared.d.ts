import type { World, WorldOptions } from "../index.js";

/** Simulated latency in milliseconds: fixed, or drawn from [min, max] by the seed and the request. */
export type Latency = number | [number, number] | { min: number; max: number } | false;

/** Options every adapter shares: a ready `world`, or world options from which one is created. */
export interface AdapterOptions extends WorldOptions {
  /** Answer from this world (mutations then persist in it). Wins over the world options. */
  world?: World;
  /** Default none. Deterministic: a pure function of the seed and the request. */
  latency?: Latency;
  /** Replaces `setTimeout` for the wait; receives the milliseconds. Use it in tests. */
  delay?: (ms: number) => void | Promise<void>;
}
