// The single-operation pipeline shared by graceholder() and the world (docs/design.md section 8).
import { infer } from "./infer.js";
import { run } from "./execute.js";
import { GraceholderError } from "./errors.js";
import { LOCALES } from "./vocab/en.js";
import { resolvePacks } from "./pack-registry.js";

export const DEFAULT_SEED = "graceholder";
export const DEFAULT_ANCHOR = "2025-01-01T00:00:00.000Z";

export function anchorMs(anchorDate) {
  const ms = anchorDate instanceof Date ? anchorDate.getTime() : typeof anchorDate === "string" ? Date.parse(anchorDate) : NaN;
  if (!Number.isFinite(ms)) {
    throw new GraceholderError("bad-options", `anchorDate must be an ISO date string or a Date, got ${String(anchorDate)}`);
  }
  return ms;
}

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
 * Infer and execute one query operation. Returns the raw graphql-js result (errors included) with
 * plain JSON-compatible `data`. `world` is the optional world view (src/world.js).
 * @param {any} query
 * @param {any} [options]
 * @param {any} [world]
 */
export function generateResult(query, options = {}, world = undefined) {
  const locale = options.locale ?? "en";
  checkLocale(locale);
  const ms = anchorMs(options.anchorDate ?? DEFAULT_ANCHOR);
  const realism = realismOptions(options);
  const inferred = infer(query, {
    packs: realism.packs,
    realistic: realism.realistic,
    operationName: options.operationName,
    spec: options.spec,
    strict: options.strict,
    variables: options.variables,
    nullableTypes: world?.deletedTypes(),
    nullableFields: world?.nullFields(),
  });
  const result = run(inferred, {
    seed: options.seed ?? DEFAULT_SEED,
    anchorMs: ms,
    locale,
    images: realism.images,
    packs: realism.packs,
    realistic: realism.realistic,
    variables: options.variables,
    poolSize: inferred.spec.options.poolSize,
    endlessTotal: inferred.spec.options.endlessTotal,
    world,
  });
  // graphql-js builds null-prototype objects; hand back plain JSON-compatible data
  if (result.data !== undefined && result.data !== null) result.data = JSON.parse(JSON.stringify(result.data));
  return result;
}
