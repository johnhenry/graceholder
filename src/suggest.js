// suggestSpec: an authoring-time helper (docs/design.md section 10). The core never calls it,
// imports no LLM SDK, and the model is an injected function.
import { GraceholderError } from "./errors.js";
import { inferSchema } from "./index.js";
import { GENERATOR_NAMES } from "./generators.js";

/** Bumped when the prompt wording changes. The wording is not part of the output-stability guarantee. */
export const SUGGEST_PROMPT_VERSION = "suggest-spec/1";

const GRAMMAR = `A spec is a JSON object. Each key is a path pattern, each value a field spec.
Path patterns use schema field names (never aliases), dot separated from the root field:
  users.name      exactly that path
  *.status        "*" is exactly one segment
  **.createdAt    "**" is zero or more segments (patterns are anchored at the root unless they start with "**")
  @Type.field     the field on that type wherever it appears (for example @User.email)
Precedence per property: exact path (or @Type.field) over "*" over "**"; heuristics apply to anything you leave out.
Field spec properties (all optional):
  list / one      boolean, force a list or a single object
  count           n, [min, max] or {"min": 1, "max": 5}, the size of a list (and its declared total)
  gen             "name" or {"name": "int", "args": {"min": 1, "max": 9}}, a generator for a scalar
  pattern         string; # digit, ? lowercase letter, A uppercase letter, * letter or digit, \\ escapes
  pick            array of values or {"value": v, "weight": n} objects, chosen from deterministically
  nullRate        number from 0 to 1
  derive          {"from": "otherFieldOnTheSameType"}
  type            a type name; types with the same name share one pool of entities
  seed            string or number, a different seed for this subtree
  key             identifying argument name(s), for example ["orgId", "userId"]
  own / shared    boolean; own = not drawn from the shared pool of its type
Top-level "$options" may set {"poolSize": n, "endlessTotal": n}.`;

/**
 * @param {string} query
 * @param {Record<string, any>} [spec] an existing spec the model should extend
 * @returns {string}
 */
export function buildSuggestPrompt(query, spec) {
  const { sdl, decisions } = inferSchema(query, spec);
  const lines = decisions
    .filter((d) => d.kind !== "arg" && d.kind !== "unused")
    .map((d) => `${d.path} | ${d.kind} | ${JSON.stringify(d.value)} | ${d.source}${d.rule ? ` | ${d.rule}` : ""}`);
  return [
    `graceholder ${SUGGEST_PROMPT_VERSION}`,
    "",
    "graceholder generates repeatable mock data for a GraphQL query, inferring a schema from field names with heuristics.",
    "Review the inferred schema below and return a spec that corrects only the places where the heuristics are probably wrong",
    "(wrong list/object shape, wrong type, a better generator, realistic counts or value sets).",
    "",
    "## Query",
    query.trim(),
    "",
    "## Inferred schema",
    sdl.trim(),
    "",
    "## Inferred decisions (path | kind | value | source | rule)",
    ...lines,
    "",
    ...(spec && Object.keys(spec).length ? ["## Existing spec (keep the entries you agree with)", JSON.stringify(spec, null, 2), ""] : []),
    "## Spec grammar",
    GRAMMAR,
    "",
    "## Known generators",
    GENERATOR_NAMES.join(", "),
    "",
    "## Reply",
    "Return ONLY a JSON object that is a valid spec (no commentary). Use only the generators listed above and only paths that exist in the query.",
    "",
  ].join("\n");
}

function buildRepairPrompt(original, reply, problems) {
  return [
    original.trimEnd(),
    "",
    "## Your previous reply",
    reply,
    "",
    "## Problems found",
    ...problems.map((p) => `- ${p}`),
    "",
    "Return ONLY a corrected JSON spec object.",
    "",
  ].join("\n");
}

function extractJson(text) {
  const fenced = /```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/.exec(text);
  if (fenced) return fenced[1];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) return trimmed;
  const a = trimmed.indexOf("{");
  const b = trimmed.lastIndexOf("}");
  return a >= 0 && b > a ? trimmed.slice(a, b + 1) : trimmed;
}

/** @returns {{ spec: Record<string, any> } | { problems: string[] }} */
function validate(reply, query) {
  if (typeof reply !== "string" || reply.trim() === "") return { problems: ["the reply was empty or not text; return a JSON object"] };
  let spec;
  try {
    spec = JSON.parse(extractJson(reply));
  } catch (e) {
    return { problems: [`the reply could not be parsed as JSON (${/** @type {Error} */ (e).message})`] };
  }
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { problems: ["the spec must be a JSON object keyed by path pattern"] };
  }
  try {
    const { decisions } = inferSchema(query, spec);
    const unused = decisions.filter((d) => d.kind === "unused").map((d) => `spec path ${JSON.stringify(d.path)} matches no field in the query`);
    if (unused.length) return { problems: unused };
  } catch (e) {
    if (!(e instanceof GraceholderError)) throw e;
    return { problems: [`${e.message}${e.hint ? ` (${e.hint})` : ""}`] };
  }
  return { spec };
}

/**
 * Ask an injected model for a spec, validate it, and offer one repair round.
 * @param {string} query
 * @param {{ llm: (prompt: string) => Promise<string>, spec?: Record<string, any> }} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function suggestSpec(query, { llm, spec }) {
  if (typeof llm !== "function") throw new GraceholderError("bad-options", "suggestSpec needs an llm function: (prompt) => Promise<string>");
  const prompt = buildSuggestPrompt(query, spec);
  const first = await llm(prompt);
  let result = validate(first, query);
  if ("spec" in result) return result.spec;
  const second = await llm(buildRepairPrompt(prompt, typeof first === "string" ? first : String(first), result.problems));
  result = validate(second, query);
  if ("spec" in result) return result.spec;
  throw new GraceholderError("bad-suggestion", "the model did not return a valid spec after one repair round", { hint: result.problems.join("\n") });
}
