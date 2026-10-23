// @johnhenry/graceholder: consistently repeatable generated data from a GraphQL query.
// Design: docs/design.md. Every value is a pure function of a key (section 2).
import { infer } from "./infer.js";
import { run } from "./execute.js";
import { GraceholderError } from "./errors.js";
import { LOCALES } from "./vocab/en.js";
import { KEY_SCHEME } from "./key.js";

export { GraceholderError, KEY_SCHEME };

const DEFAULT_SEED = "graceholder";
const DEFAULT_ANCHOR = "2025-01-01T00:00:00.000Z";

function anchorMs(anchorDate) {
  const ms = anchorDate instanceof Date ? anchorDate.getTime() : typeof anchorDate === "string" ? Date.parse(anchorDate) : NaN;
  if (!Number.isFinite(ms)) {
    throw new GraceholderError("bad-options", `anchorDate must be an ISO date string or a Date, got ${String(anchorDate)}`);
  }
  return ms;
}

/**
 * Generate data for a query. Synchronous and deterministic.
 * @param {string|import("graphql").DocumentNode} query
 * @param {import("./index.js").Options} [options]
 */
export function graceholder(query, options = {}) {
  const mode = options.errors ?? "throw";
  try {
    const locale = options.locale ?? "en";
    if (!Object.hasOwn(LOCALES, locale)) {
      throw new GraceholderError("unknown-locale", `unknown locale ${JSON.stringify(locale)}`, { hint: `available: ${Object.keys(LOCALES).join(", ")}` });
    }
    if (options.spec !== undefined) {
      throw new GraceholderError("unsupported", "the side-car spec is not supported yet", { hint: "it arrives in a later release" });
    }
    const ms = anchorMs(options.anchorDate ?? DEFAULT_ANCHOR);
    const inferred = infer(query, { operationName: options.operationName });
    const result = run(inferred, { seed: options.seed ?? DEFAULT_SEED, anchorMs: ms, variables: options.variables });
    if (result.errors?.length) {
      // an error raised by one of our resolvers (bad cursor, bad arguments) keeps its own code
      const own = result.errors.find((e) => e.originalError instanceof GraceholderError);
      if (own) throw own.originalError;
      throw new GraceholderError("graphql", result.errors[0].message, { cause: result.errors[0], errors: result.errors });
    }
    // graphql-js builds null-prototype objects; hand back plain JSON-compatible data
    const data = JSON.parse(JSON.stringify(result.data));
    return mode === "result" ? { data } : data;
  } catch (e) {
    if (mode === "result" && e instanceof GraceholderError && e.code === "graphql") {
      return { errors: e.errors ?? [e.cause ?? e] };
    }
    throw e;
  }
}

/**
 * Infer the SDL and the decisions behind it, without generating data.
 * @param {string|import("graphql").DocumentNode} query
 * @param {unknown} [spec] reserved for the side-car spec
 * @param {{ operationName?: string }} [options]
 */
export function inferSchema(query, spec, options = {}) {
  if (spec !== undefined) {
    throw new GraceholderError("unsupported", "the side-car spec is not supported yet", { hint: "it arrives in a later release" });
  }
  const { sdl, decisions, document } = infer(query, options);
  return { sdl, decisions, document };
}
