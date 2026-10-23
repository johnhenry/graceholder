// @johnhenry/graceholder: consistently repeatable generated data from a GraphQL query.
// Design: docs/design.md. Every value is a pure function of a key (section 2).
import { infer } from "./infer.js";
import { GraceholderError } from "./errors.js";
import { generateResult } from "./generate.js";
import { KEY_SCHEME } from "./key.js";
import { registerPack, registeredPacks } from "./pack-registry.js";
import { realismOptions } from "./generate.js";

export { GraceholderError, KEY_SCHEME, registerPack, registeredPacks };
export { createWorld } from "./world.js";
export { suggestSpec, buildSuggestPrompt, SUGGEST_PROMPT_VERSION } from "./suggest.js";
export { specFromSamples, analyzeSamples } from "./learn.js";

/**
 * Generate data for a query. Synchronous and deterministic.
 * @param {string|import("graphql").DocumentNode} query
 * @param {import("./index.js").Options} [options]
 */
export function graceholder(query, options = {}) {
  const mode = options.errors ?? "throw";
  try {
    const result = generateResult(query, options);
    if (result.errors?.length) {
      // an error raised by one of our resolvers (bad cursor, bad arguments) keeps its own code
      const own = result.errors.find((e) => e.originalError instanceof GraceholderError);
      if (own) throw own.originalError;
      throw new GraceholderError("graphql", result.errors[0].message, { cause: result.errors[0], errors: result.errors });
    }
    const data = result.data;
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
 * @param {Record<string, any>} [spec] side-car spec (section 5.2)
 * @param {{ operationName?: string, variables?: Record<string, unknown>, strict?: boolean, distributions?: "uniform"|"realistic", packs?: any[], images?: "url"|"svg", schema?: any }} [options]
 */
export function inferSchema(query, spec, options = {}) {
  const realism = realismOptions(options);
  const { sdl, decisions, document } = infer(query, { operationName: options.operationName, variables: options.variables, strict: options.strict, spec, schema: options.schema, packs: realism.packs, realistic: realism.realistic });
  return { sdl, decisions, document };
}
