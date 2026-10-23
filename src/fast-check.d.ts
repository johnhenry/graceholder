import type { Arbitrary } from "fast-check";
import type { DocumentNode } from "graphql";
import type { Options, Scenario, ResultError } from "./index.js";

/** One generated sample. Printed by fast-check as `graceholder({"seed":...,"scenarios":[...]})`. */
export interface GraceholderSample {
  seed: string | number;
  scenarios: Scenario[];
  /** The (possibly partial) data; null when an error reached the root. */
  data: Record<string, unknown> | null;
  /** GraphQL errors from the `errors` scenario, in the usual JSON shape; empty otherwise. */
  errors: ResultError[];
}

export interface GraceholderArbitraryOptions extends Omit<Options, "seed" | "scenario" | "errors"> {
  /** Arbitrary of seeds. Default: integers from 0 to 2^31-1, shrinking toward 0. */
  seeds?: Arbitrary<string | number>;
  /** Scenarios that may be combined (default: all). `false` or `[]` for none. The chosen set shrinks toward empty. */
  scenarios?: Scenario[] | false;
}

/** An arbitrary over seeds and scenario sets that maps each to graceholder output. */
export declare function graceholderArbitrary(query: string | DocumentNode, options?: GraceholderArbitraryOptions): Arbitrary<GraceholderSample>;
/** Regenerate a sample from the `{ seed, scenarios }` a failing run printed. */
export declare function replay(
  query: string | DocumentNode,
  sample: { seed: string | number; scenarios?: Scenario[] },
  options?: Omit<GraceholderArbitraryOptions, "seeds" | "scenarios">,
): GraceholderSample;
export declare const SCENARIOS: readonly Scenario[];
export default graceholderArbitrary;
