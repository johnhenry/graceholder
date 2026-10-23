// A shared, persistent world: pinned entities and deterministic mutations (docs/design.md section 16, World).
// State is an append-only log of effects; replaying the log rebuilds the identical state.
import { Kind, valueFromASTUntyped, visit } from "graphql";
import { GraceholderError } from "./errors.js";
import { toDocument } from "./infer.js";
import { compileSpec } from "./spec.js";
import { keyStream } from "./key.js";
import { tokenize, typeNameFor } from "./naming.js";
import { ID_ARGS, entityKeyFromArgs } from "./args.js";
import { streamWorld } from "./bulk/stream.js";
import { anchorMs, checkLocale, generateResult, realismOptions, DEFAULT_ANCHOR, DEFAULT_SEED } from "./generate.js";

const DEFAULT_VERBS = {
  create: "create", add: "create", insert: "create",
  update: "update", edit: "update", set: "update",
  delete: "delete", remove: "delete",
};
const INPUT_ARGS = ["input", "data", "patch"];
const RELATION = /^(.+?)(?:Id|_id)$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (msg, extra) => new GraceholderError("bad-options", msg, extra);
const recKey = (type, key) => `${type}\u0000${key}`;
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);

function parseRef(ref) {
  const i = typeof ref === "string" ? ref.indexOf(":") : -1;
  const type = i > 0 ? ref.slice(0, i) : "";
  const key = i > 0 ? ref.slice(i + 1) : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type) || key === "") {
    throw bad(`an entity reference looks like "User:42", got ${JSON.stringify(ref)}`);
  }
  return { type, key };
}

/** The state the executor reads (see execute.js `ws`), rebuilt from the log. */
class WorldState {
  constructor() {
    /** @type {Map<string, { fields: Record<string, any>, created: boolean, updated: boolean }>} "Type\0key" -> record */
    this.recs = new Map();
    /** @type {Map<string, Set<string>>} Type -> deleted keys */
    this.deleted = new Map();
    /** @type {Map<string, string[]>} Type -> keys in creation order (may include deleted keys) */
    this.created = new Map();
    /** @type {Map<string, Array<{ ownerType: string, ownerKey: string }>>} */
    this.rels = new Map();
    /** @type {"start"|"end"|undefined} */
    this.position = undefined;
    /** @type {Set<string>} "Type.field" of every field set to null, which must be nullable in the SDL */
    this.nulls = new Set();
  }

  clear() {
    this.recs.clear();
    this.deleted.clear();
    this.created.clear();
    this.rels.clear();
    this.nulls.clear();
    this.position = undefined;
  }

  entity(type, key) {
    return this.recs.get(recKey(type, key));
  }

  isDeleted(type, key) {
    return this.deleted.get(type)?.has(key) ?? false;
  }

  nullFields() {
    return this.nulls.size ? this.nulls : undefined;
  }

  deletedKeys(type) {
    return this.deleted.get(type) ?? [];
  }

  deletedTypes() {
    const out = new Set();
    for (const [t, set] of this.deleted) if (set.size) out.add(t);
    return out.size ? out : undefined;
  }

  createdKeys(type) {
    return (this.created.get(type) ?? []).filter((k) => !this.isDeleted(type, k));
  }

  relatedKeys(type, ownerType, ownerKey) {
    return this.createdKeys(type).filter((k) => (this.rels.get(recKey(type, k)) ?? []).some((r) => r.ownerType === ownerType && r.ownerKey === ownerKey));
  }

  touches(type) {
    return (this.deleted.get(type)?.size ?? 0) > 0 || (this.created.get(type)?.length ?? 0) > 0;
  }

  taken(type, key) {
    return this.isDeleted(type, key) || (this.created.get(type) ?? []).includes(key);
  }

  /**
   * Apply one log entry.
   * @param {any} e
   */
  apply(e) {
    const rk = recKey(e.type, e.key);
    if (e.op === "pin" || e.op === "update") {
      const rec = this.recs.get(rk) ?? { fields: {}, created: false, updated: false };
      this.recs.set(rk, rec);
      Object.assign(rec.fields, e.fields);
      for (const [k, v] of Object.entries(e.fields)) if (v === null) this.nulls.add(`${e.type}.${k}`);
      if (e.op === "update") rec.updated = true;
      if (e.rel) this.rels.set(rk, e.rel);
    } else if (e.op === "create") {
      this.deleted.get(e.type)?.delete(e.key);
      const list = this.created.get(e.type) ?? [];
      this.created.set(e.type, [...list.filter((k) => k !== e.key), e.key]);
      this.recs.set(rk, { fields: { ...e.fields }, created: true, updated: false });
      for (const [k, v] of Object.entries(e.fields)) if (v === null) this.nulls.add(`${e.type}.${k}`);
      if (e.rel?.length) this.rels.set(rk, e.rel);
      else this.rels.delete(rk);
    } else if (e.op === "delete") {
      if (!this.deleted.has(e.type)) this.deleted.set(e.type, new Set());
      /** @type {Set<string>} */ (this.deleted.get(e.type)).add(e.key);
      this.recs.delete(rk);
      this.rels.delete(rk);
    }
  }
}

const OPS = new Set(["pin", "create", "update", "delete"]);

function checkEntry(e, i) {
  const fail = (m) => bad(`log entry ${i}: ${m}`);
  if (!isObject(e) || !OPS.has(e.op)) throw fail("op must be one of pin, create, update, delete");
  if (typeof e.type !== "string" || typeof e.key !== "string" || e.key === "") throw fail("type and key must be strings");
  if (e.op !== "delete" && !isObject(e.fields)) throw fail("fields must be an object");
  if (e.rel !== undefined && !Array.isArray(e.rel)) throw fail("rel must be an array");
}

function plainErrors(errors) {
  return errors.map((e) => {
    const out = { message: e.message };
    if (e.locations) out.locations = e.locations.map((l) => ({ line: l.line, column: l.column }));
    if (e.path) out.path = [...e.path];
    const ext = { ...(e.extensions ?? {}) };
    if (e.originalError instanceof GraceholderError) ext.code = e.originalError.code;
    if (Object.keys(ext).length) out.extensions = ext;
    return out;
  });
}

function thrownErrors(e) {
  if (!(e instanceof GraceholderError)) throw e;
  if (e.code === "graphql" && e.errors) return plainErrors(e.errors);
  const ext = { code: e.code };
  if (e.path !== undefined) ext.path = e.path;
  if (e.hint !== undefined) ext.hint = e.hint;
  return [{ message: e.message, extensions: ext }];
}

function selectOperation(doc, operationName) {
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  let op;
  if (operationName !== undefined && operationName !== null) {
    op = ops.find((o) => o.name?.value === operationName);
    if (!op) throw new GraceholderError("bad-operation", `no operation named ${JSON.stringify(operationName)}`);
  } else if (ops.length === 1) {
    op = ops[0];
  } else {
    throw new GraceholderError("bad-operation", ops.length === 0 ? "the document has no operation" : "the document has several operations; pass operationName");
  }
  if (op.operation === "subscription") throw new GraceholderError("bad-operation", "subscription operations are not supported");
  return op;
}

/** @skip / @include on a root field. */
function skipped(node, vars) {
  for (const d of node.directives ?? []) {
    const name = d.name.value;
    if (name !== "skip" && name !== "include") continue;
    const arg = d.arguments?.find((a) => a.name.value === "if");
    const v = arg ? valueFromASTUntyped(arg.value, vars) : undefined;
    if (name === "skip" && v === true) return true;
    if (name === "include" && v === false) return true;
  }
  return false;
}

/** Root fields of a mutation, looking through fragments on `Mutation`. */
function rootFields(selSet, fragments, vars, out = []) {
  for (const s of selSet.selections) {
    if (skipped(s, vars)) continue;
    if (s.kind === Kind.FIELD) out.push(s);
    else if (s.kind === Kind.INLINE_FRAGMENT) rootFields(s.selectionSet, fragments, vars, out);
    else if (s.kind === Kind.FRAGMENT_SPREAD) {
      const def = fragments.get(s.name.value);
      if (!def) throw new GraceholderError("graphql", `Unknown fragment "${s.name.value}".`);
      rootFields(def.selectionSet, fragments, vars, out);
    }
  }
  return out;
}

/**
 * Mutation inference (docs/design.md section 16, World): the verb and entity type of a root mutation field.
 * @returns {{ op: "create"|"update"|"delete", type: string, read: string, cfg: any }}
 */
export function classifyMutation(fieldName, mutations) {
  const cfg = mutations.fields[fieldName];
  const tokens = tokenize(fieldName);
  const op = cfg?.op ?? mutations.verbs[tokens[0]] ?? DEFAULT_VERBS[tokens[0]];
  if (!op) {
    throw new GraceholderError("bad-mutation", `cannot tell what the mutation "${fieldName}" does: "${tokens[0]}" is not a known verb`, {
      hint: `known verbs: ${Object.keys({ ...DEFAULT_VERBS, ...mutations.verbs }).join(", ")}; declare others in the spec: { "$mutations": { "verbs": { "${tokens[0]}": "update" } } } or { "fields": { "${fieldName}": { "op": "update", "type": "..." } } }`,
    });
  }
  const noun = tokens.slice(1).join("_");
  if (!cfg?.type && noun === "") {
    throw new GraceholderError("bad-mutation", `the mutation "${fieldName}" names no entity type`, { hint: `name it like ${tokens[0]}User or set { "$mutations": { "fields": { "${fieldName}": { "op": "${op}", "type": "User" } } } }` });
  }
  const type = cfg?.type ?? typeNameFor(noun);
  return { op, type, read: cfg?.read ?? lowerFirst(type), cfg };
}

/**
 * @param {import("./index.js").WorldOptions & { log?: any[] }} [options]
 */
export function createWorld(options = {}) {
  if (!isObject(options)) throw bad("createWorld expects an options object");
  const seed = options.seed ?? DEFAULT_SEED;
  const locale = options.locale ?? "en";
  checkLocale(locale);
  const anchorDate = options.anchorDate ?? DEFAULT_ANCHOR;
  const anchorIso = new Date(anchorMs(anchorDate)).toISOString();
  const spec = options.spec === undefined ? undefined : structuredClone(options.spec);
  const mutations = compileSpec(spec).mutations;
  // realism options (docs/design.md section 16, Realism) apply to every query of the world; fail early on a bad one
  realismOptions(options);
  const realism = {
    ...(options.packs ? { packs: options.packs } : {}),
    ...(options.images !== undefined ? { images: options.images } : {}),
    ...(options.distributions !== undefined ? { distributions: options.distributions } : {}),
  };
  const base = { seed, spec, anchorDate: anchorIso, locale, strict: options.strict, ...realism, schema: options.schema };

  const state = new WorldState();
  state.position = mutations.position;
  /** @type {any[]} */
  let log = [];
  const append = (entry) => {
    state.apply(entry);
    log.push(entry);
  };
  const replay = (entries) => {
    if (!Array.isArray(entries)) throw bad("log must be an array");
    entries.forEach(checkEntry);
    for (const e of entries) append(structuredClone(e));
  };
  if (options.log !== undefined) replay(options.log);

  const view = state;
  const run = (query, opts) => generateResult(query, { ...base, ...opts }, view);

  /** Variable values: declared defaults, then the provided ones. */
  const varsOf = (op, provided) => {
    const out = {};
    for (const def of op.variableDefinitions ?? []) if (def.defaultValue) out[def.variable.name.value] = valueFromASTUntyped(def.defaultValue);
    return { ...out, ...(provided ?? {}) };
  };

  const notFound = (type, key) => new GraceholderError("not-found", `${type} ${JSON.stringify(key)} does not exist (it was deleted)`);

  /** Decide the effect of one mutation field and return it (nothing is written). */
  function effectOf(node, vars) {
    const name = node.name.value;
    const cls = classifyMutation(name, mutations);
    const args = {};
    for (const a of node.arguments ?? []) args[a.name.value] = valueFromASTUntyped(a.value, vars);
    const inputName = cls.cfg?.input;
    let input;
    if (inputName === "args") input = undefined;
    else if (inputName) input = isObject(args[inputName]) ? args[inputName] : undefined;
    else input = INPUT_ARGS.map((n) => args[n]).find(isObject);

    const idNames = cls.op === "create" ? [cls.cfg?.idArg ?? "id"] : cls.cfg?.idArg ? [cls.cfg.idArg] : ID_ARGS;
    const idName = idNames.find((n) => args[n] != null) ?? idNames.find((n) => input?.[n] != null) ?? idNames.find((n) => isObject(args.where) && args.where[n] != null);
    const idValue = idName === undefined ? undefined : (args[idName] ?? input?.[idName] ?? args.where?.[idName]);
    const key = idName === undefined ? undefined : entityKeyFromArgs({ id: idValue });

    let fields;
    if (input) {
      fields = { ...input };
    } else {
      fields = {};
      for (const [k, v] of Object.entries(args)) if (k !== "where" || !isObject(v)) fields[k] = v;
    }
    if (idName !== undefined) delete fields[idName];
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];

    const rel = [];
    for (const [fname, value] of Object.entries(fields)) {
      const m = RELATION.exec(fname);
      if (!m || value === null || typeof value === "object") continue;
      const ownerType = mutations.relations[`${cls.type}.${fname}`] ?? typeNameFor(m[1]);
      rel.push({ ownerType, ownerKey: entityKeyFromArgs({ id: value }) });
    }
    return { name, ...cls, key, fields, rel };
  }

  /** Evaluate the selection of a mutation field as the query field for the affected entity. */
  function selectionOf(node, doc, op, vars, cls, key, errorsOut) {
    const alias = node.alias?.value ?? node.name.value;
    const field = {
      kind: Kind.FIELD,
      alias: { kind: Kind.NAME, value: alias },
      name: { kind: Kind.NAME, value: cls.read },
      arguments: [{ kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: "id" }, value: { kind: Kind.STRING, value: key } }],
      directives: [],
      selectionSet: node.selectionSet,
    };
    const fragments = doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION);
    const used = new Set();
    for (const part of [field, ...fragments]) visit(part, { Variable: (v) => void used.add(v.name.value) });
    const query = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation: "query",
          variableDefinitions: (op.variableDefinitions ?? []).filter((d) => used.has(d.variable.name.value)),
          selectionSet: { kind: Kind.SELECTION_SET, selections: [field] },
        },
        ...fragments,
      ],
    };
    /** @type {any} */
    const mutSpec = { ...(spec ?? {}) };
    mutSpec[cls.read] = { ...(mutSpec[cls.read] ?? {}) };
    if (mutSpec[cls.read].list === undefined) mutSpec[cls.read].one = true;
    if (typeNameFor(cls.read) !== cls.type && mutSpec[cls.read].type === undefined) mutSpec[cls.read].type = cls.type;
    const res = run(query, { variables: vars, spec: mutSpec, strict: false });
    if (res.errors?.length) errorsOut.push(...plainErrors(res.errors).map((e) => ({ ...e, path: [alias, ...(e.path ?? []).slice(1)] })));
    return res.data?.[alias] ?? null;
  }

  function mutate(doc, op, provided) {
    const vars = varsOf(op, provided);
    const fragments = new Map(doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
    const data = {};
    const errors = [];
    for (const node of rootFields(op.selectionSet, fragments, vars)) {
      const alias = node.alias?.value ?? node.name.value;
      try {
        if (node.name.value === "__typename") {
          data[alias] = "Mutation";
          continue;
        }
        const eff = effectOf(node, vars);
        const { op: kind, type } = eff;
        let key = eff.key;
        if (kind === "create") {
          const seq = log.length + 1;
          if (key === undefined) {
            let n = keyStream({ seed, scope: "a", typeName: type, entityKey: "world", fieldName: "create", subKeys: [seq] }).int(1000000, 9999999);
            while (state.taken(type, String(n))) n++;
            key = String(n);
          } else if (state.createdKeys(type).includes(key)) {
            throw new GraceholderError("bad-mutation", `${type} ${JSON.stringify(key)} already exists`);
          }
          // a decimal key is its own id; any other key needs the id field pinned to it
          if (!/^[0-9]+$/.test(key) && eff.fields.id === undefined) eff.fields = { id: key, ...eff.fields };
          append({ op: "create", type, key, fields: eff.fields, ...(eff.rel.length ? { rel: eff.rel } : {}), mutation: eff.name });
        } else {
          if (key === undefined) {
            throw new GraceholderError("bad-mutation", `the mutation "${eff.name}" needs an identifying argument (${ID_ARGS.join(", ")}), in its arguments or its input`);
          }
          if (state.isDeleted(type, key)) throw notFound(type, key);
          if (kind === "update") {
            append({ op: "update", type, key, fields: eff.fields, ...(eff.rel.length ? { rel: eff.rel } : {}), mutation: eff.name });
          }
        }
        if (!node.selectionSet) {
          data[alias] = kind === "delete" ? true : key;
        } else {
          data[alias] = selectionOf(node, doc, op, vars, eff, key, errors);
        }
        // a delete returns the entity as it was; the write comes after the read
        if (kind === "delete") append({ op: "delete", type, key, mutation: eff.name });
      } catch (e) {
        if (!(e instanceof GraceholderError)) throw e;
        data[alias] = null;
        errors.push({ ...thrownErrors(e)[0], path: [alias] });
      }
    }
    return errors.length ? { data, errors } : { data };
  }

  return {
    /**
     * Run a query or a mutation against the world. Returns a GraphQL result: `{ data }`, or with
     * `errors` (parse, validation, argument and mutation errors never throw here).
     */
    query(query, opts = {}) {
      try {
        const doc = toDocument(query);
        const op = selectOperation(doc, opts.operationName);
        if (op.operation === "mutation") return mutate(doc, op, opts.variables);
        const res = run(doc, { variables: opts.variables, operationName: opts.operationName });
        if (res.errors?.length) return res.data === undefined ? { errors: plainErrors(res.errors) } : { data: res.data, errors: plainErrors(res.errors) };
        return { data: res.data };
      } catch (e) {
        return { errors: thrownErrors(e) };
      }
    },

    /**
     * The root collection of a query as a lazy iterable (see `stream`), reflecting the pins and
     * mutations at the time each window is generated: consume it before mutating the world.
     */
    stream(query, opts = {}) {
      return streamWorld(query, { ...base, ...opts }, view);
    },

    /** Override fields of one entity ("User:42"); unpinned fields stay generated. Pins are logged. */
    pin(ref, fields) {
      const { type, key } = parseRef(ref);
      if (!isObject(fields)) throw bad("pin expects an object of field values");
      if (state.isDeleted(type, key)) throw notFound(type, key);
      const clean = {};
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) clean[k] = v;
      append(structuredClone({ op: "pin", type, key, fields: clean }));
      return this;
    },

    /** `{ seed, spec, anchorDate, locale, log }`: pass it to createWorld to replay to the same state. */
    export() {
      // pack objects are exported by name: register them (registerPack) before replaying
      const extra = { ...realism, ...(realism.packs ? { packs: realism.packs.map((p) => (typeof p === "string" ? p : p.name)) } : {}) };
      return structuredClone({ seed, spec, anchorDate: anchorIso, locale, ...extra, log });
    },

    /** Forget every pin and mutation. */
    reset() {
      state.clear();
      state.position = mutations.position;
      log = [];
      return this;
    },
  };
}
