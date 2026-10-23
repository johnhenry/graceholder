// Execution: graphql-js `execute` over the inferred schema with keyed resolvers
// (docs/design.md section 8, key rules in section 2 and 3).
import { buildSchema, execute, validate } from "graphql";
import { GraceholderError } from "./errors.js";
import { keyStream } from "./key.js";
import { generate } from "./generators.js";
import { graphqlError } from "./infer.js";

export const POOL_SIZE = 100;
const ROOT = "Query";

/**
 * @param {{ sdl: string, document: any, model: Map<string, Map<string, any>> }} inferred
 * @param {{ seed: string|number, anchorMs: number, variables?: Record<string, unknown> }} run
 * @returns {import("graphql").ExecutionResult}
 */
export function run(inferred, run) {
  const schema = buildSchema(inferred.sdl);
  const invalid = validate(schema, inferred.document);
  if (invalid.length) return { errors: invalid };

  const key = (scope, typeName, entityKey, fieldName, subKeys) =>
    ({ seed: run.seed, scope, typeName, entityKey, fieldName, subKeys });

  const count = (parent, entityKey, fieldName) => keyStream(key("l", parent, entityKey, fieldName)).int(3, 10);

  const scalar = (f, parent, entityKey, fieldName, subKeys) =>
    generate(f.gen, {
      stream: keyStream(key("e", parent, entityKey, fieldName, subKeys)),
      anchorMs: run.anchorMs,
      args: f.genArgs,
      typeName: parent,
      entityKey,
      fieldName,
    });

  const fieldResolver = (source, _args, _ctx, info) => {
    const parent = info.parentType.name;
    const fieldName = info.fieldName;
    const f = inferred.model.get(parent)?.get(fieldName);
    if (!f) return undefined;
    const entityKey = source.entityKey;
    if (f.kind === "scalar") {
      if (!f.list) return scalar(f, parent, entityKey, fieldName);
      const n = count(parent, entityKey, fieldName);
      return Array.from({ length: n }, (_, i) => scalar(f, parent, entityKey, fieldName, [i]));
    }
    if (f.list) {
      const n = count(parent, entityKey, fieldName);
      const shared = parent === ROOT; // E1: top-level collections are the type pool
      return Array.from({ length: n }, (_, i) => ({
        typeName: f.typeName,
        entityKey: shared ? String(i + 1) : `${entityKey}.${fieldName}.${i + 1}`,
      }));
    }
    // E2: a top-level singular field is entity 1; otherwise a stable reference into the pool
    const k = parent === ROOT ? "1" : String(keyStream(key("l", parent, entityKey, fieldName)).int(1, POOL_SIZE));
    return { typeName: f.typeName, entityKey: k };
  };

  /** @type {any} */
  const result = execute({
    schema,
    document: inferred.document,
    rootValue: { typeName: ROOT, entityKey: ROOT },
    variableValues: run.variables,
    fieldResolver,
  });
  if (typeof result?.then === "function") {
    throw new GraceholderError("internal", "graceholder resolvers must be synchronous");
  }
  return result;
}

export { graphqlError };
