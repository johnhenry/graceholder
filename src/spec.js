// Side-car spec: validation, path patterns and precedence (docs/design.md section 5).
import { GraceholderError } from "./errors.js";
import { normalizeScenarios } from "./scenario.js";

const SPEC_PROPS = new Set(["list", "one", "count", "gen", "pattern", "pick", "nullRate", "derive", "type", "seed", "key", "shared", "own", "scenario"]);
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bad = (msg, path) => new GraceholderError("bad-spec", msg, { path });

/** Normalise `count` (n, [min, max] or {min, max}) to { n } or { min, max }. */
export function normalizeCount(value, fail) {
  const intOk = (x) => Number.isInteger(x) && x >= 0;
  if (intOk(value)) return { n: value };
  if (Array.isArray(value) && value.length === 2 && value.every(intOk) && value[0] <= value[1]) return { min: value[0], max: value[1] };
  if (value && typeof value === "object" && !Array.isArray(value) && intOk(value.min) && intOk(value.max) && value.min <= value.max) return { min: value.min, max: value.max };
  throw fail(`count must be a non-negative integer, [min, max] or {min, max} with min <= max, got ${JSON.stringify(value)}`);
}

/** Normalise `pick` values to a non-empty array. */
export function checkPick(values, fail) {
  if (!Array.isArray(values) || values.length === 0) throw fail("pick must be a non-empty array of values or {value, weight} objects");
  const weighted = values.map((v) => v !== null && typeof v === "object" && "weight" in v);
  if (weighted.some(Boolean) && !weighted.every(Boolean)) throw fail("pick cannot mix plain values and {value, weight} objects");
  for (const v of values) if (v !== null && typeof v === "object" && "weight" in v && !(v.weight > 0)) throw fail("pick weights must be positive");
  return values;
}

/** Validate one FieldSpec and return its canonical override properties. */
function fieldProps(key, f) {
  const fail = (m) => bad(`spec ${JSON.stringify(key)}: ${m}`, key);
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw fail("must be an object");
  for (const k of Object.keys(f)) if (!SPEC_PROPS.has(k)) throw fail(`unknown property ${JSON.stringify(k)} (known: ${[...SPEC_PROPS].join(", ")})`);
  const props = {};
  if (f.list !== undefined || f.one !== undefined) {
    if (f.list !== undefined && typeof f.list !== "boolean") throw fail("list must be a boolean");
    if (f.one !== undefined && typeof f.one !== "boolean") throw fail("one must be a boolean");
    if (f.list && f.one) throw new GraceholderError("conflicting-overrides", `spec ${JSON.stringify(key)}: list and one are both set`, { path: key });
    if (f.list) props.list = true;
    else if (f.one) props.list = false;
  }
  if (f.count !== undefined) props.count = normalizeCount(f.count, fail);
  const gens = ["gen", "pattern", "pick"].filter((k) => f[k] !== undefined);
  if (gens.length > 1) throw new GraceholderError("conflicting-overrides", `spec ${JSON.stringify(key)}: ${gens.join(" and ")} are both set`, { path: key });
  if (f.gen !== undefined) {
    const g = typeof f.gen === "string" ? { name: f.gen, args: {} } : f.gen;
    if (!g || typeof g.name !== "string" || (g.args !== undefined && (g.args === null || typeof g.args !== "object" || Array.isArray(g.args)))) {
      throw fail('gen must be a name or { name, args }');
    }
    props.gen = { name: g.name, args: g.args ?? {} };
  }
  if (f.pattern !== undefined) {
    if (typeof f.pattern !== "string") throw fail("pattern must be a string");
    props.gen = { name: "pattern", args: { p: f.pattern } };
  }
  if (f.pick !== undefined) props.gen = { name: "oneOf", args: { values: checkPick(f.pick, fail) } };
  if (f.scenario !== undefined) props.scenario = normalizeScenarios(f.scenario, fail);
  if (f.nullRate !== undefined) {
    if (typeof f.nullRate !== "number" || !(f.nullRate >= 0 && f.nullRate <= 1)) throw fail("nullRate must be a number between 0 and 1");
    props.nullRate = f.nullRate;
  }
  if (f.derive !== undefined) {
    if (!f.derive || typeof f.derive.from !== "string" || !f.derive.from) throw fail("derive must be { from: fieldName }");
    props.derive = f.derive.from;
  }
  if (f.type !== undefined) {
    if (typeof f.type !== "string" || !SEGMENT.test(f.type)) throw fail("type must be a GraphQL type name");
    props.type = f.type;
  }
  if (f.seed !== undefined) {
    if (typeof f.seed !== "string" && typeof f.seed !== "number") throw fail("seed must be a string or number");
    props.seed = String(f.seed);
  }
  if (f.key !== undefined) {
    const keys = typeof f.key === "string" ? [f.key] : f.key;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === "string" && SEGMENT.test(k))) throw fail("key must be an argument name or a non-empty array of argument names");
    props.key = keys;
  }
  for (const k of ["shared", "own"]) {
    if (f[k] !== undefined) {
      if (typeof f[k] !== "boolean") throw fail(`${k} must be a boolean`);
      props[k] = f[k];
    }
  }
  if (props.own && props.shared) throw new GraceholderError("conflicting-overrides", `spec ${JSON.stringify(key)}: shared and own are both set`, { path: key });
  return props;
}

export const MUTATION_OPS = ["create", "update", "delete"];

/** Validate the `$mutations` block (docs/design.md section 16, World) and return its canonical form. */
function compileMutations(value) {
  const fail = (m) => bad(`$mutations: ${m}`, "$mutations");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail("must be an object");
  const out = { verbs: {}, fields: {}, relations: {}, position: undefined };
  for (const [k, v] of Object.entries(value)) {
    if (k === "verbs") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw fail("verbs must be an object of verb -> create | update | delete");
      for (const [verb, op] of Object.entries(v)) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(verb) || /[A-Z]/.test(verb)) throw fail(`verb ${JSON.stringify(verb)} must be one lowercase word`);
        if (!MUTATION_OPS.includes(op)) throw fail(`verbs.${verb} must be one of ${MUTATION_OPS.join(", ")}`);
        out.verbs[verb] = op;
      }
    } else if (k === "position") {
      if (v !== "start" && v !== "end") throw fail('position must be "start" or "end"');
      out.position = v;
    } else if (k === "relations") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw fail("relations must be an object of Type.inputField -> OwnerType");
      for (const [rel, owner] of Object.entries(v)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(rel) || typeof owner !== "string" || !SEGMENT.test(owner)) throw fail(`relations.${rel} must map Type.inputField to an owner type name`);
        out.relations[rel] = owner;
      }
    } else if (k === "fields") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw fail("fields must be an object keyed by mutation field name");
      for (const [name, cfg] of Object.entries(v)) {
        if (!SEGMENT.test(name)) throw fail(`fields.${name}: not a field name`);
        if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw fail(`fields.${name} must be an object`);
        for (const key of Object.keys(cfg)) if (!["op", "type", "idArg", "input", "read"].includes(key)) throw fail(`fields.${name}: unknown property ${JSON.stringify(key)}`);
        if (!MUTATION_OPS.includes(cfg.op)) throw fail(`fields.${name}.op must be one of ${MUTATION_OPS.join(", ")}`);
        for (const key of ["type", "idArg", "read"]) if (cfg[key] !== undefined && (typeof cfg[key] !== "string" || !SEGMENT.test(cfg[key]))) throw fail(`fields.${name}.${key} must be a name`);
        if (cfg.input !== undefined && (typeof cfg.input !== "string" || !SEGMENT.test(cfg.input))) throw fail(`fields.${name}.input must be "args" or an argument name`);
        out.fields[name] = { ...cfg };
      }
    } else {
      throw fail(`unknown property ${JSON.stringify(k)} (known: verbs, fields, relations, position)`);
    }
  }
  return out;
}

/**
 * Validate and compile a side-car spec.
 * @param {unknown} spec
 * @returns {{ entries: any[], options: { poolSize?: number, endlessTotal?: number }, mutations: any }}
 */
export function compileSpec(spec) {
  if (spec === undefined || spec === null) return { entries: [], options: {}, mutations: compileMutations({}) };
  if (typeof spec !== "object" || Array.isArray(spec)) throw bad("spec must be an object keyed by path pattern");
  const options = {};
  const entries = [];
  let mutations = compileMutations({});
  for (const [key, value] of Object.entries(spec)) {
    if (key === "$mutations") {
      mutations = compileMutations(value);
      continue;
    }
    if (key === "$options") {
      if (value === null || typeof value !== "object") throw bad("$options must be an object");
      for (const [k, v] of Object.entries(value)) {
        if (k !== "poolSize" && k !== "endlessTotal") throw bad(`unknown $options property ${JSON.stringify(k)}`, key);
        if (!Number.isInteger(v) || v < 1) throw bad(`$options.${k} must be a positive integer`, key);
        options[k] = v;
      }
      continue;
    }
    const props = fieldProps(key, value);
    /** @type {any} */
    let entry;
    if (key.startsWith("@")) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(key);
      if (!m) throw bad(`invalid type-scoped key ${JSON.stringify(key)}; use @Type.field`, key);
      entry = { key, typeName: m[1], fieldName: m[2], props, klass: 2, exact: 0, prefix: 0 };
    } else {
      const segments = key.split(".");
      if (!segments.every((s) => s === "*" || s === "**" || SEGMENT.test(s))) throw bad(`invalid path pattern ${JSON.stringify(key)}`, key);
      const literals = segments.filter((s) => s !== "*" && s !== "**").length;
      const klass = segments.includes("**") ? 0 : segments.includes("*") ? 1 : 2;
      let prefix = 0;
      while (prefix < segments.length && segments[prefix] !== "*" && segments[prefix] !== "**") prefix++;
      entry = { key, segments, props, klass, exact: klass === 2 ? 1 : 0, prefix, literals };
    }
    entry.index = entries.length;
    entry.used = false;
    entries.push(entry);
  }
  return { entries, options, mutations };
}

function matchSegments(pattern, path, pi = 0, si = 0) {
  if (pi === pattern.length) return si === path.length;
  const p = pattern[pi];
  if (p === "**") {
    for (let k = si; k <= path.length; k++) if (matchSegments(pattern, path, pi + 1, k)) return true;
    return false;
  }
  if (si >= path.length) return false;
  if (p !== "*" && p !== path[si]) return false;
  return matchSegments(pattern, path, pi + 1, si + 1);
}

/** Does a compiled entry address the field reached by `path` (dot-joined field names) on `typeName`? */
export function matchPath(entry, path, typeName, fieldName) {
  if (entry.typeName !== undefined) return entry.typeName === typeName && entry.fieldName === fieldName;
  return matchSegments(entry.segments, path.split("."));
}

const better = (a, b) =>
  a.klass !== b.klass ? a.klass > b.klass :
  a.exact !== b.exact ? a.exact > b.exact :
  a.prefix !== b.prefix ? a.prefix > b.prefix :
  a.index > b.index;

/**
 * Spec properties for one field occurrence: for each property, the value from the most
 * specific matching entry that defines it (exact > `*` > `**`, then longer literal prefix,
 * then the later declaration).
 * @returns {Record<string, any>}
 */
export function specProps(compiled, path, typeName, fieldName) {
  const best = {};
  for (const entry of compiled.entries) {
    if (!matchPath(entry, path, typeName, fieldName)) continue;
    entry.used = true;
    for (const prop of Object.keys(entry.props)) if (!best[prop] || better(entry, best[prop].entry)) best[prop] = { entry, value: entry.props[prop] };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.value]));
}

/**
 * Every spec entry that addresses a field, per property, best first (the first one is the winner of
 * `specProps`). Unlike `specProps` it marks nothing as used. For explain().
 * @returns {Record<string, Array<{ key: string, value: any, klass: "exact"|"*"|"**"|"@Type", index: number }>>}
 */
export function specTrace(compiled, path, typeName, fieldName) {
  const byProp = {};
  for (const entry of compiled.entries) {
    if (!matchPath(entry, path, typeName, fieldName)) continue;
    for (const prop of Object.keys(entry.props)) (byProp[prop] ??= []).push(entry);
  }
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const [prop, entries] of Object.entries(byProp)) {
    entries.sort((a, b) => (better(a, b) ? -1 : 1));
    out[prop] = entries.map((e) => ({ key: e.key, value: e.props[prop], klass: e.typeName !== undefined ? "@Type" : ["**", "*", "exact"][e.klass], index: e.index }));
  }
  return out;
}
