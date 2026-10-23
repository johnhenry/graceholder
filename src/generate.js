// The single-operation pipeline shared by graceholder() and the world (docs/design.md section 8).
import { infer } from "./infer.js";
import { run } from "./execute.js";
import { GraceholderError } from "./errors.js";
import { LOCALES } from "./vocab/en.js";
import { resolvePacks } from "./pack-registry.js";
import { anchorMs, DEFAULT_ANCHOR } from "./anchor.js";
import { globalScenarios, errorRateOf } from "./scenario.js";

export const DEFAULT_SEED = "graceholder";
export { DEFAULT_ANCHOR, anchorMs };

export function checkLocale(locale) {
  if (!Object.hasOwn(LOCALES, locale)) {
    throw new GraceholderError("unknown-locale", `unknown locale ${JSON.stringify(locale)}`, { hint: `available: ${Object.keys(LOCALES).join(", ")}` });
  }
}

/** Validate the realism options (images, distributions, packs) and resolve the packs (docs/design.md section 16, Realism). */
export function realismOptions(options) {
  const images = options.images ?? "url";
  if (images !== "url" && images !== "svg") throw new GraceholderError("bad-options", `images must be "url" or "svg", got ${JSON.stringify(images)}`);
  const distributions = options.distributions ?? "uniform";
  if (distributions !== "uniform" && distributions !== "realistic") {
    throw new GraceholderError("bad-options", `distributions must be "uniform" or "realistic", got ${JSON.stringify(distributions)}`);
  }
  return { images, realistic: distributions === "realistic", packs: resolvePacks(options.packs) };
}

/**
 * Infer one query operation and resolve the execution options (shared by single runs and bulk streams).
 * @param {any} query
 * @param {any} [options]
 * @param {any} [world]
 */
export function prepare(query, options = {}, world = undefined) {
  const locale = options.locale ?? "en";
  checkLocale(locale);
  const ms = anchorMs(options.anchorDate ?? DEFAULT_ANCHOR);
  const realism = realismOptions(options);
  const scenario = globalScenarios(options.scenario);
  const errorRate = errorRateOf(options.scenarioOptions);
  const inferred = infer(query, {
    packs: realism.packs,
    realistic: realism.realistic,
    operationName: options.operationName,
    spec: options.spec,
    strict: options.strict,
    variables: options.variables,
    scenario,
    nullableTypes: world?.deletedTypes(),
    nullableFields: world?.nullFields(),
    schema: options.schema,
  });
  const runOptions = {
    seed: options.seed ?? DEFAULT_SEED,
    anchorMs: ms,
    locale,
    images: realism.images,
    packs: realism.packs,
    realistic: realism.realistic,
    variables: options.variables,
    poolSize: inferred.spec.options.poolSize,
    endlessTotal: inferred.spec.options.endlessTotal,
    errorRate,
    world,
  };
  return { inferred, runOptions };
}

/**
 * Infer and execute one query operation. Returns the raw graphql-js result (errors included) with
 * plain JSON-compatible `data`. `world` is the optional world view (src/world.js).
 * @param {any} query
 * @param {any} [options]
 * @param {any} [world]
 */
export function generateResult(query, options = {}, world = undefined) {
  const { inferred, runOptions } = prepare(query, options, world);
  const result = run(inferred, runOptions);
  // graphql-js builds null-prototype objects; hand back plain JSON-compatible data
  if (result.data !== undefined && result.data !== null) result.data = JSON.parse(JSON.stringify(result.data));
  return result;
}
