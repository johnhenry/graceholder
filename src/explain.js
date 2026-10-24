// explain(query, path, options): why does the value at a path look the way it does? (docs/design.md section 20)
//
// The query is run once, exactly as graceholder() runs it, with a `probe` that records what each resolver
// on the way to the value did (src/execute.js). Nothing here draws a random number or changes an output:
// the probe only reads. The explanation is assembled from that trace and from the inference result.
import { ScenarioError } from "./scenario.js";
import { GraceholderError } from "./errors.js";
import { prepare } from "./generate.js";
import { run } from "./execute.js";
import { keyString, hashKey, KEY_SCHEME } from "./key.js";
import { specTrace } from "./spec.js";
import { classifyScalar, listRule } from "./rules.js";
import { tokenize } from "./naming.js";
import { PAGING_ARGS } from "./args.js";
import { toDocument, selectOperation } from "./infer.js";

const bad = (msg, extra) => new GraceholderError("bad-path", msg, extra);

/** One line per inference rule (docs/design.md section 4.2), so an explanation can say what a rule id means. */
export const RULE_TEXT = Object.freeze({
  L1: "list or single value forced by @list/@one or a spec entry",
  L2: "a paging argument (first, last, limit, offset, skip, take, page, after) makes the field a list",
  L3: "the last word of the field name is plural",
  L4: "the name is list-like (list, all...)",
  L5: "an ids argument or a list-literal argument",
  L6: "no list rule matched: a single value",
  L7: "realistic mode: a history/series/timeline/trend object is a time series",
  N1: "type name given by @type or a spec entry",
  N2: "type name from a fragment type condition",
  N3: "type name from the singularised, PascalCased field name",
  S3: "a Relay connection (edges, pageInfo, nodes with totalCount, or a ...Connection type)",
  S4: "several type conditions make a union or an interface",
  T1: "field named id or ending in Id: an ID",
  T2: "__typename",
  T3: "email-like name: person.email",
  T4: "url-like name",
  T5: "image-like name (avatar, photo, thumbnail...)",
  T6: "phone-like name",
  T7: "boolean-like name (is, has, can... or enabled, active...)",
  T8: "integer-like name (count, age, quantity, views...)",
  T9: "decimal-like name (price, total, rating, lat...)",
  T10: "date-like name (createdAt, date, birthday...)",
  T11: "a named string kind (name, city, status, bio, slug...)",
  T13: "no name rule matched: two words",
  T14: "realistic mode: a time-series point",
  P1: "a vocabulary pack recognised the name",
  gen: "generator given by @gen, @pattern, @pick or a spec entry",
  derive: "derived from another field of the same entity",
  "C-count": "a count of a sibling collection (<x>Count, total<X>s)",
  schema: "taken from the schema",
  "schema-enum": "an enum of the schema: one of its values",
  "schema-builtin": "a built-in scalar of the schema",
  "schema-scalar": "a custom scalar of the schema",
  "schema-abstract": "an interface or union of the schema",
  "unused-spec-path": "a spec path that matched no field",
});

const ruleText = (id) => (id ? RULE_TEXT[id] ?? (id.startsWith("schema:") ? `${RULE_TEXT.schema}; ${RULE_TEXT[id.slice(7)] ?? id.slice(7)}` : undefined) : undefined);

/** Parse `users.3.email` / `users[3].email` / `["users", 3, "email"]` into response keys and indexes. */
export function parsePath(path) {
  let parts;
  if (Array.isArray(path)) parts = path.map((p) => (typeof p === "number" ? p : String(p)));
  else if (typeof path === "string") parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((p) => p !== "");
  else throw bad("a path is a string such as users.3.email, or an array of response keys and indexes");
  if (parts.length === 0) throw bad("the path is empty", { hint: "name a response key, for example users.0.email" });
  return parts.map((p) => {
    if (typeof p === "number") {
      if (!Number.isInteger(p) || p < 0) throw bad(`list indexes are non-negative integers, got ${p}`);
      return p;
    }
    return /^(0|[1-9][0-9]*)$/.test(p) ? Number(p) : p;
  });
}

const dotted = (target) => target.map(String).join(".");

function valueAt(data, target) {
  let cur = data;
  for (const seg of target) {
    if (cur === null || cur === undefined || typeof cur !== "object") return { found: false };
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return { found: false };
    } else if (Array.isArray(cur) || !Object.hasOwn(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

const hex = (n) => `0x${n.toString(16).padStart(16, "0")}`;

/** A key as the library builds it: the exact string, its parts and its XXH64 hash. */
function describeKey(k) {
  const parts = [KEY_SCHEME, k.seed, k.scope, k.typeName, k.entityKey, k.fieldName, ...(k.subKeys ?? [])].map(String);
  return { string: keyString(k), parts, hash: hex(hashKey(k)) };
}

const compact = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

/** The names path (`users.email`, no aliases or indexes) of the fields on the way to the target. */
const namesPath = (events) => events.map((e) => e.fieldName).join(".");

function describeScenario(f, info, notes, globalNames, collection) {
  const names = f.scenario ?? [];
  if (names.length === 0) return null;
  const source = info?.ovSrc?.scenario === "spec" ? "spec" : globalNames.length ? "option" : "spec";
  let effect = "none: the field is unaffected";
  const err = notes.find((n) => n.step === "scenario-errors");
  if (err) effect = err.hit ? `the field fails: draw ${err.draw} < errorRate ${err.rate}` : `the field is spared: draw ${err.draw} >= errorRate ${err.rate}`;
  if (notes.some((n) => n.step === "scenario-nulls")) effect = "the field is null (nulls scenario)";
  if (collection && names.includes("empty")) effect = "the collection is forced to be empty (empty scenario)";
  else if (collection && names.includes("huge")) effect = `the collection is forced to a huge size: ${collection.size} items (huge scenario)`;
  const edge = notes.find((n) => n.step === "scenario-edge");
  if (edge) effect = `replaced by a ${edge.mode} edge case (was ${JSON.stringify(edge.replaced)})`;
  return { names: [...names], source, effect };
}

/** Candidate sources for one overridable property, in precedence order (docs/design.md section 5.3). */
function precedenceFor(prop, info, trace, heuristic) {
  const candidates = [];
  const winnerSource = info.ovSrc?.[prop];
  if (winnerSource === "directive") candidates.push({ source: "directive", value: info.ov[prop] });
  (trace[prop] ?? []).forEach((c) => candidates.push({ source: "spec", entry: c.key, matches: c.klass, value: c.value }));
  if (heuristic) candidates.push({ source: "heuristic", ...heuristic });
  const winner = candidates.findIndex((c) => c.source === "directive") >= 0 ? candidates.findIndex((c) => c.source === "directive") : candidates.findIndex((c) => c.source === "spec") >= 0 ? candidates.findIndex((c) => c.source === "spec") : candidates.length - 1;
  return { property: prop, winner: candidates[winner]?.source, candidates: candidates.map((c, i) => ({ ...c, wins: i === winner })) };
}

/**
 * Build an explanation from one traced run.
 * @param {any} query
 * @param {Array<string|number>} target
 * @param {any} options
 * @param {any} [world] the internal world state (src/world.js)
 */
export function explainWith(query, target, options, world) {
  const doc = toDocument(query);
  const op = selectOperation(doc, options.operationName);
  void op;
  const { inferred, runOptions } = prepare(doc, options, world);
  /** @type {{ target: Array<string|number>, events: any[], notes: any[] }} */
  const probe = { target, events: [], notes: [] };
  const result = run(inferred, { ...runOptions, probe });
  const scenarioErrors = result.errors?.filter((e) => e.originalError instanceof ScenarioError) ?? [];
  const other = result.errors?.filter((e) => !(e.originalError instanceof ScenarioError)) ?? [];
  if (other.length) {
    const own = other.find((e) => e.originalError instanceof GraceholderError);
    if (own) throw own.originalError;
    throw new GraceholderError("graphql", other[0].message, { cause: other[0], errors: other });
  }
  const data = result.data === undefined || result.data === null ? result.data : JSON.parse(JSON.stringify(result.data));
  const found = valueAt(data, target);
  if (!found.found) {
    // a missing value is explained by the first null (or failed) value on the way to it
    for (let i = 1; i < target.length; i++) {
      const prefix = target.slice(0, i);
      const at = valueAt(data, prefix);
      if (!at.found) break;
      if (at.value === null || at.value === undefined) return unavailable(target, prefix, probe, scenarioErrors, inferred, world);
    }
    const events = probe.events.filter((e) => e.type === "field");
    const where = events.length ? `${events.length} of ${target.length} segments exist` : "the first segment is not a response key of the query";
    throw bad(`there is no value at ${dotted(target)} (${where})`, { path: dotted(target), hint: "paths use response keys (aliases) and zero-based list indexes, for example users.0.email" });
  }
  const here = scenarioErrors.find((e) => e.path && e.path.length === target.length && e.path.every((p, i) => String(p) === String(target[i])));
  return assemble({ target, options, inferred, probe, value: found.value, error: here, world, runOptions });
}

/** The target does not exist because a value on the way is null or failed. */
function unavailable(target, prefix, probe, scenarioErrors, inferred, world) {
  const key = dotted(prefix);
  const err = scenarioErrors.find((e) => e.path && e.path.length === prefix.length && e.path.every((p, i) => String(p) === String(prefix[i])));
  const group = probe.events.find((e) => e.type === "field" && dotted(e.path) === key);
  const notes = probe.events.filter((e) => e.type === "ancestor-note" && dotted(e.path) === key);
  const entity = probe.events.find((e) => e.type === "entity" && e.deleted && probe.events.indexOf(e) > probe.events.indexOf(group));
  let because = "the value is null";
  let by;
  const errNote = notes.find((n) => n.step === "scenario-errors");
  const nullNote = notes.find((n) => n.step === "nullRate");
  if (err) {
    because = `the field failed (${err.message}): the errors scenario drew ${errNote?.draw} < errorRate ${errNote?.rate}`;
    by = compact({ scenario: "errors", message: err.message, draw: errNote?.draw, rate: errNote?.rate, key: errNote && keyString(errNote.key) });
  } else if (notes.some((n) => n.step === "scenario-nulls")) {
    because = "the nulls scenario made the field null";
    by = { scenario: "nulls" };
  } else if (nullNote?.hit) {
    because = `nullRate ${nullNote.rate} hit (draw ${nullNote.draw})`;
    by = { nullRate: nullNote.rate, draw: nullNote.draw, key: keyString(nullNote.key) };
  } else if (entity) {
    because = `the entity ${group?.f?.typeName}:${entity.key} was deleted in the world`;
    by = { world: "deleted", entity: `${group?.f?.typeName}:${entity.key}` };
  }
  void inferred;
  void world;
  return { path: dotted(target), value: undefined, kind: "unavailable", blockedAt: key, because, by, summary: `${dotted(target)} does not exist: ${key} is null because ${because}.` };
}

function assemble({ target, options, inferred, probe, value, error, world, runOptions }) {
  const fieldEvents = probe.events.filter((e) => e.type === "field");
  const self = fieldEvents.find((e) => e.rel === "self" || e.rel === "element");
  const lastAncestor = [...fieldEvents].reverse().find((e) => e.rel === "ancestor");
  // the group of events of each resolver on the way: its field event and what the resolver decided
  /** @type {any[]} */
  const groups = [];
  for (const e of probe.events) {
    if (e.type === "field") groups.push({ field: e, extras: [] });
    else groups.at(-1).extras.push(e);
  }
  const leaf = self ?? lastAncestor; // the resolver that produced the value (or the collection it is an element of)
  const leafGroup = groups.find((g) => g.field === leaf);
  const ancestors = groups.filter((g) => g.field.rel === "ancestor");
  const ROOT = inferred.rootType ?? "Query";
  const names = namesPath(groups.map((g) => g.field));
  const info = inferred.byPath.get(names);
  const f = leaf.f;
  const isElementOfObjectList = !self; // the target is an item of a list of objects: no resolver ran for it
  const out = { path: dotted(target), value: error ? undefined : value };

  // ---- what kind of thing is at the path
  let kind;
  if (self?.rel === "element") kind = "list-element";
  else if (isElementOfObjectList) kind = f.connection ? "connection-member" : "item";
  else if (f.connection) kind = "connection";
  else if (f.kind === "scalar") kind = f.list ? "scalar-list" : "scalar";
  else kind = f.list ? "list" : "object";
  out.kind = kind;
  if (error) out.error = { message: error.message, extensions: error.extensions };

  // ---- the field
  const fieldInfo = compact({
    name: leaf.fieldName,
    alias: String(leaf.path.at(-1)) !== leaf.fieldName ? String(leaf.path.at(-1)) : undefined,
    parentType: leaf.parent,
    path: names,
    type: f.kind === "scalar" ? f.sdl : f.typeName,
    list: f.list,
    nullable: Boolean(f.nullable || f.nullRate > 0 || (info && info.nullable)),
  });
  out.field = fieldInfo;

  // ---- entity identity and how the owner was reached
  /** @type {any[]} */
  const how = [];
  for (const g of ancestors) {
    const ent = g.extras.find((x) => x.type === "entity");
    const col = g.extras.find((x) => x.type === "collection");
    if (ent) how.push(compact({ path: dotted(g.field.path), field: g.field.fieldName, via: "entity", mode: ent.mode, key: ent.key, shared: ent.mode !== "owned" && ent.mode !== "inherited", note: entityNote(ent) }));
    else if (col) {
      how.push(compact({ path: dotted(g.field.path), field: g.field.fieldName, via: col.style, index: col.index, key: col.childKey, shared: col.shared, size: col.count, window: { start: col.start, total: col.total, endless: col.endless }, countKey: col.countKey && keyString(col.countKey), declaredCount: col.declared ?? undefined }));
    }
  }
  let ownerType;
  let ownerKey;
  let ownerShared;
  if (isElementOfObjectList) {
    // the target itself is an item of the last collection
    const col = leafGroup.extras.find((x) => x.type === "collection");
    ownerType = f.connection ? inferred.model.get(f.typeName)?.get("nodes")?.typeName ?? f.typeName : f.typeName;
    ownerKey = col?.childKey;
    ownerShared = col?.shared;
    const entity = leafGroup.extras.find((x) => x.type === "entity");
    if (entity) {
      ownerKey = entity.key;
      ownerShared = entity.mode !== "owned" && entity.mode !== "inherited";
    }
  } else if (kind === "object") {
    const ent = leafGroup.extras.find((x) => x.type === "entity");
    ownerType = f.typeName;
    ownerKey = ent?.key;
    ownerShared = ent ? ent.mode !== "owned" && ent.mode !== "inherited" : undefined;
  } else if (kind === "list" || kind === "connection") {
    ownerType = leaf.parent;
    ownerKey = leaf.entityKey;
    ownerShared = how.at(-1)?.shared;
  } else {
    ownerType = leaf.parent;
    ownerKey = leaf.entityKey;
    ownerShared = how.at(-1)?.shared;
  }
  if (leaf.parent === ROOT && !isElementOfObjectList && kind !== "object") {
    out.entity = { identity: ROOT, type: ROOT, key: ROOT, shared: true, how: [], note: "a field of the query root" };
  } else if (ownerKey !== undefined) {
    out.entity = compact({ identity: `${ownerType}:${ownerKey}`, type: ownerType, key: String(ownerKey), shared: ownerShared, how });
  }

  // ---- collection details (lists, connections, items)
  const col = leafGroup.extras.find((x) => x.type === "collection");
  if (col && !isElementOfObjectList) {
    out.collection = compact({ size: col.count, window: { start: col.start, total: col.total, endless: col.endless }, declaredCount: col.declared ?? undefined, countKey: col.countKey && keyString(col.countKey), members: col.shared === undefined ? undefined : col.shared ? "shared (drawn from the pool of the type)" : "owned by the parent entity" });
  }
  if (leafGroup.extras.find((x) => x.type === "scalar-list")) {
    const sl = leafGroup.extras.find((x) => x.type === "scalar-list");
    out.collection = compact({ size: sl.count, declaredCount: sl.declared ?? undefined, countKey: keyString(sl.countKey) });
  }

  // ---- Relay machinery has no generator of its own
  if (f.special && SPECIAL_TEXT[f.special]) {
    out.special = { name: f.special === "pageInfoField" ? leaf.fieldName : f.special, description: SPECIAL_TEXT[f.special] };
    const conn = [...groups].reverse().flatMap((g) => g.extras).find((x) => x.type === "collection" && x.style === "connection");
    if (conn) out.collection = compact({ size: conn.count, window: { start: conn.start, total: conn.total, endless: conn.endless }, declaredCount: conn.declared ?? undefined, countKey: conn.countKey && keyString(conn.countKey) });
  }

  // ---- the value's own recipe (scalars)
  const gen = probe.notes.find((n) => n.step === "generate" && n.depth === 0);
  const worldValue = probe.notes.find((n) => n.step === "world-value" && n.depth === 0);
  if (gen) {
    out.key = describeKey(gen.key);
    out.generator = { name: gen.gen, args: gen.args ?? {}, outputType: info?.sdl ?? f.sdl };
  }
  const slots = probe.notes.filter((n) => n.step === "slot" && n.depth === undefined);
  if (gen) {
    const persona = compact({
      type: gen.personaType,
      key: gen.personaKey,
      inherited: gen.personaKey !== leaf.entityKey ? true : undefined,
      slots: slots.length ? slots.map((s) => ({ name: s.name, key: keyString(s.key) })) : undefined,
      pinned: gen.pinned ?? undefined,
    });
    if (persona.slots || persona.pinned) out.persona = persona;
  }
  const derive = probe.notes.find((n) => n.step === "derive");
  const countOf = probe.notes.find((n) => n.step === "count.of");
  const order = probe.notes.find((n) => n.step === "order");
  const orderDetail = probe.notes.find((n) => n.step === "order-detail");
  if (derive) {
    const inner = probe.notes.find((n) => n.step === "generate" && n.depth > 0);
    out.derivation = compact({ kind: "derive", from: derive.from, as: derive.gen, sourceKey: inner && keyString(inner.key), sourceGenerator: inner?.gen });
    if (inner) out.key = describeKey(inner.key);
    out.generator = { name: derive.gen, args: f.genArgs ?? {}, outputType: info?.sdl ?? f.sdl };
  } else if (countOf) {
    out.derivation = { kind: "count.of", of: countOf.of, size: countOf.size };
    out.generator = { name: "count.of", args: { of: countOf.of }, outputType: "Int" };
  } else if (order) {
    out.derivation = compact({ kind: "order", gen: order.gen, items: orderDetail?.items, itemsField: orderDetail?.itemsField, itemType: orderDetail?.itemType, taxPercent: orderDetail?.taxPercent, taxKey: orderDetail && keyString(orderDetail.taxKey), subtotalCents: orderDetail?.subtotalCents });
    out.generator = { name: order.gen, args: {}, outputType: "Float" };
  }

  // ---- the seed in effect
  out.seed = describeSeed(leaf.seed, info, inferred, options, runOptions, ancestors, inferred.byPath);

  // ---- why this rule, spec entry or directive
  if (info) {
    const decisions = inferred.decisions.filter((d) => d.path === names);
    const scalarD = decisions.find((d) => d.kind === "scalar");
    const typeD = decisions.find((d) => d.kind === "type");
    const listD = decisions.find((d) => d.kind === "list");
    const main = f.kind === "scalar" ? scalarD : typeD ?? listD;
    if (main) out.rule = compact({ id: main.rule, source: main.source, description: ruleText(main.rule), pack: packOf(info, inferred, runOptions) });
    if (listD && f.kind === "scalar") out.listRule = compact({ id: listD.rule, source: listD.source, description: ruleText(listD.rule), isList: listD.value });
    else if (listD) out.listRule = compact({ id: listD.rule, source: listD.source, description: ruleText(listD.rule), isList: listD.value });
    out.decisions = decisions.map((d) => compact({ kind: d.kind, value: d.value, source: d.source, rule: d.rule }));
    out.precedence = precedenceList(info, inferred, leaf, runOptions);
  }

  // ---- scenario, nullRate, pins
  const sc = describeScenario(f, info, probe.notes, options.scenario === undefined ? [] : [].concat(options.scenario).filter((s) => s !== "none"), out.collection);
  if (sc) out.scenario = sc;
  const nr = probe.notes.find((n) => n.step === "nullRate");
  if (nr) out.nullRate = { rate: nr.rate, draw: nr.draw, key: keyString(nr.key), hit: nr.hit };
  if (worldValue) out.pin = { entity: `${worldValue.type}:${worldValue.key}`, field: worldValue.field, kind: worldValue.kind, value: worldValue.value };
  const deleted = leafGroup.extras.find((x) => x.type === "entity" && x.deleted);
  if (deleted) out.pin = { entity: `${f.typeName}:${deleted.key}`, kind: "deleted", value: null };

  // ---- the story in words
  out.summary = summarize(out, f);
  return out;
}

const SPECIAL_TEXT = {
  totalCount: "the size of the whole collection: the declared count, or the endless total (1000 unless $options.endlessTotal)",
  cursor: "an opaque cursor that encodes the position of the edge",
  pageInfoField: "paging information computed from the window of the connection",
};

const entityNote = (ent) =>
  ({
    args: `selected by the argument${ent.keyArgs ? "s " + ent.keyArgs.join(", ") : " (id, key, slug, ...)"}: the same entity wherever it is selected`,
    root: "a root field is entity 1",
    pool: `a stable reference into the pool of the type (1 to ${ent.poolSize}), drawn from the key above`,
    owned: "owned by its parent: not shared with other fields",
    inherited: "a geo-style child that shares its parent's persona",
    "connection-member": "the node of a connection edge",
  })[ent.mode];

function packOf(info, inferred, runOptions) {
  const rule = inferred.decisions.find((d) => d.path === info.path && d.kind === "scalar")?.rule;
  if (rule !== "P1") return undefined;
  const c = classifyScalar(info.name, { typeName: info.parentType, list: info.list, packs: runOptions.packs, realistic: runOptions.realistic });
  return c.pack;
}

function describeSeed(seed, info, inferred, options, runOptions, ancestors, byPath) {
  const value = String(seed);
  if (info?.ov?.seed !== undefined && String(info.ov.seed) === value) return { value, source: info.ovSrc.seed === "spec" ? "spec" : "directive" };
  if (inferred.opSeed !== undefined && String(inferred.opSeed) === value) return { value, source: "operation directive" };
  if (value === String(runOptions.seed)) return { value, source: options.seed === undefined ? "default" : "option" };
  // inherited: a @seed or a spec seed on an enclosing field applies to its whole subtree
  for (const g of [...ancestors].reverse()) {
    const names = ancestors.slice(0, ancestors.indexOf(g) + 1).map((a) => a.field.fieldName).join(".");
    const a = byPath.get(names);
    if (a?.ov?.seed !== undefined && String(a.ov.seed) === value) return { value, source: a.ovSrc.seed === "spec" ? "spec on an enclosing field" : "directive on an enclosing field", at: dotted(g.field.path) };
  }
  return { value, source: "enclosing field" };
}

const PROPS = ["gen", "list", "count", "nullRate", "derive", "type", "key", "own", "shared", "seed", "scenario"];

function precedenceList(info, inferred, leaf, runOptions) {
  const trace = specTrace(inferred.spec, info.path, info.parentType, info.name);
  const out = [];
  for (const prop of PROPS) {
    const directive = info.ovSrc?.[prop] === "directive";
    const always = (prop === "gen" && info.kind === "scalar" && !info.schemaSourced) || (prop === "list" && !info.connection && !info.schemaSourced);
    if (!directive && !trace[prop] && !always) continue;
    let heuristic;
    if (prop === "gen" && info.kind === "scalar") {
      const c = classifyScalar(info.name, { typeName: info.parentType, list: Boolean(info.list), packs: runOptions.packs, realistic: runOptions.realistic });
      heuristic = { rule: c.rule, value: c.gen, description: ruleText(c.rule) };
    } else if (prop === "list") {
      const argNames = [...(info.args?.keys() ?? [])];
      const r = listRule(info.name, { paging: argNames.some((n) => PAGING_ARGS.has(n)), idsArg: argNames.includes("ids"), listLiteralArg: false, realistic: runOptions.realistic, object: info.kind === "object" });
      heuristic = { rule: r.rule, value: r.list, description: ruleText(r.rule) };
    }
    out.push(precedenceFor(prop, info, trace, heuristic));
  }
  return out;
}

function summarize(x, f) {
  const bits = [];
  const at = x.path;
  if (x.error) return `${at} fails: ${x.error.message}${x.scenario ? ` (${x.scenario.effect})` : ""}.`;
  if (x.pin?.kind === "pin") return `${at} is ${JSON.stringify(x.value)} because ${x.pin.entity}.${x.pin.field} is pinned in the world.`;
  if (x.pin?.kind === "deleted") return `${at} is null because ${x.pin.entity} was deleted in the world.`;
  if (x.scenario?.effect && /null \(|replaced|forced/.test(x.scenario.effect) && (x.value === null || x.kind === "scalar" || x.kind === "list" || x.kind === "scalar-list")) {
    if (x.value === null && !x.generator) return `${at} is null: ${x.scenario.effect}.`;
    bits.push(`the ${x.scenario.names.join("+")} scenario: ${x.scenario.effect}`);
  }
  if (x.nullRate?.hit) bits.push(`nullRate ${x.nullRate.rate} hit (draw ${x.nullRate.draw})`);
  if (x.kind === "scalar" || x.kind === "list-element") {
    const g = x.generator;
    const via = x.derivation ? `derived (${x.derivation.kind})` : g ? `${g.name}(${Object.keys(g.args ?? {}).length ? JSON.stringify(g.args) : ""})` : "a generator";
    bits.unshift(`${at} = ${JSON.stringify(x.value)}: ${via}${x.rule ? `, chosen by rule ${x.rule.id} (${x.rule.source}${x.rule.pack ? `, pack ${x.rule.pack}` : ""})` : ""}${x.entity ? `, on entity ${x.entity.identity}${x.entity.shared ? " (shared)" : " (owned)"}` : ""}`);
    if (x.persona?.pinned) bits[0] += `; persona pinned: ${Object.entries(x.persona.pinned).map(([k, v]) => `${k}=${v}`).join(", ")}`;
    if (x.special) bits[0] = `${at} = ${JSON.stringify(x.value)}: ${x.special.description}`;
  } else if (x.kind === "object" || x.kind === "item" || x.kind === "connection-member") {
    bits.unshift(`${at} is entity ${x.entity?.identity ?? "?"}${x.entity?.shared ? " (shared)" : " (owned)"}`);
  } else {
    bits.unshift(`${at} is a ${x.kind} of ${f.typeName ?? f.sdl}${x.collection ? `, ${x.collection.size} items` : ""}`);
  }
  return bits.join("; ") + ".";
}

/**
 * Explain the value at `path` of a query: its key, generator, rule, persona, entity and scenario effect.
 * Runs the query once with a read-only trace; output never changes.
 * @param {string|import("graphql").DocumentNode} query
 * @param {string|Array<string|number>} path response keys and zero-based indexes, for example `users.3.email`
 * @param {import("./index.js").Options & { world?: any }} [options]
 */
export function explain(query, path, options = {}) {
  const { world, ...rest } = options;
  const target = parsePath(path);
  if (world !== undefined) {
    if (typeof world?.explain !== "function") throw new GraceholderError("bad-options", "options.world must be a world made by createWorld");
    return world.explain(query, target, rest);
  }
  return explainWith(query, target, rest, undefined);
}

