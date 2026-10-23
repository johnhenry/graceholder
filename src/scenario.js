// Scenarios: repeatable edge-case modes (docs/design.md section 16, Scenarios).
// A scenario never changes how a value is generated; it replaces what a field returns.
// Every choice is a pure function of a key, so scenario output is as repeatable as the rest.
import { GraceholderError } from "./errors.js";

/** Canonical order; a scenario set is always normalised to this order. */
export const SCENARIOS = Object.freeze(["empty", "huge", "nulls", "unicode", "boundary", "errors"]);

/**
 * Normalise a scenario value: a name, an array of names, or "none" / [] (no scenario).
 * Returns undefined when nothing was given, [] for an explicit "none".
 * @param {unknown} value
 * @param {(msg: string) => Error} fail
 * @returns {string[]|undefined}
 */
export function normalizeScenarios(value, fail) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const names = new Set();
  for (const s of list) {
    if (s === "none") continue;
    if (typeof s !== "string" || !SCENARIOS.includes(s)) {
      throw fail(`unknown scenario ${JSON.stringify(s)} (known: ${SCENARIOS.join(", ")}, or "none")`);
    }
    names.add(s);
  }
  return SCENARIOS.filter((s) => names.has(s));
}

export const globalScenarios = (value) => normalizeScenarios(value, (m) => new GraceholderError("bad-options", `scenario: ${m}`)) ?? [];

/** Default share of eligible fields that fail under the errors scenario. */
export const DEFAULT_ERROR_RATE = 0.25;

export function errorRateOf(options) {
  const r = options?.errorRate;
  if (r === undefined) return DEFAULT_ERROR_RATE;
  if (typeof r !== "number" || !(r >= 0 && r <= 1)) throw new GraceholderError("bad-options", `scenarioOptions.errorRate must be a number between 0 and 1, got ${JSON.stringify(r)}`);
  return r;
}

/** List sizes under `huge`, by how many lists enclose the field (a flat 500 would explode when nested). */
const HUGE_BY_DEPTH = [100, 15, 6, 3];
export const hugeSize = (depth) => HUGE_BY_DEPTH[Math.min(depth, HUGE_BY_DEPTH.length - 1)];
/** Total of an endless collection (connection, paged list) under `huge`. */
export const HUGE_TOTAL = 100000;

/** Generators whose output is free text (the only strings the unicode scenario replaces). */
const TEXT_GENS = new Set([
  "words", "sentence", "paragraph", "title",
  "person.first", "person.last", "person.full", "person.bio", "person.jobTitle",
  "company.name", "product.name",
  "place.address", "place.city", "place.country", "place.state", "place.street",
]);
export const isTextGen = (gen) => TEXT_GENS.has(gen);

const LONG_UNIT = "The quick brown fox jumps over the lazy dog \u{1F98A} ";

/** Strings that break layouts and encoders, kept as escapes so the file is plain ASCII. */
const UNICODE = Object.freeze([
  // right-to-left
  "مرحبا بالعالم",
  "שלום עולם",
  "abc مرحبا 123 שלום def",
  "‮evil‬ bidi override",
  // emoji, ZWJ sequences, flags, skin tones
  "\u{1F600}\u{1F680}\u{1F389}",
  "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466} family",
  "\u{1F1EF}\u{1F1F5}\u{1F1FA}\u{1F1F8} flags \u{1F44D}\u{1F3FD}",
  // combining marks
  "Z͖͓͡à͔l͒͆g̕o҉",
  "é vs é, ñ vs ñ",
  // wide, CJK, zero-width, astral
  "日本語のテキストと漢字",
  "zero​width‌joiners⁠here",
  "\u{1D4D0}\u{1D4D1}\u{1D4D2} \u{20BB7}\u{20BB8}",
  // whitespace and markup that UIs mishandle
  "  leading and trailing  ",
  "line one\nline two\ttabbed",
  "<b>bold</b> & \"quoted\" 'text' </script>",
]);

/** One string from the corpus; the last choice is a very long one. */
export function unicodeValue(stream) {
  const i = stream.int(0, UNICODE.length); // UNICODE.length is the very long string
  if (i < UNICODE.length) return UNICODE[i];
  return LONG_UNIT.repeat(60); // about 2800 UTF-16 units, multi-code-unit emoji included
}

const INT_EDGES = Object.freeze([0, 1, -1, 2147483647, -2147483648]);
const FLOAT_EDGES = Object.freeze([0, 1, -1, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]);
const DATE_EDGES = Object.freeze(["1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "0001-01-01T00:00:00.000Z", "2038-01-19T03:14:07.000Z"]);

/** A boundary value for an SDL scalar type, or undefined when the type has no boundary here. */
export function boundaryValue(sdl, stream) {
  switch (sdl) {
    case "Int": return stream.pick(INT_EDGES);
    case "Float": return stream.pick(FLOAT_EDGES);
    case "DateTime": return stream.pick(DATE_EDGES);
    case "String": return stream.bool(0.5) ? "" : "x";
    default: return undefined;
  }
}

const FAILURES = Object.freeze([
  ["Simulated resolver failure", "INTERNAL_SERVER_ERROR"],
  ["Upstream service unavailable", "SERVICE_UNAVAILABLE"],
  ["Not authorized to read this field", "FORBIDDEN"],
  ["The request timed out", "TIMEOUT"],
]);

/** The error a field fails with; graphql-js adds the path and locations. */
export class ScenarioError extends Error {
  constructor(stream) {
    const [message, code] = stream.pick(FAILURES);
    super(message);
    this.name = "ScenarioError";
    this.extensions = { code, scenario: "errors" };
  }
}
