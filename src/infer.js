// Schema inference from a query (docs/design.md section 4): walk the selected
// operation, merge every (parentType, fieldName), apply the L/N/T rules, emit SDL.
import { parse, Kind, print, GraphQLError, valueFromASTUntyped, visit } from "graphql";
import { GraceholderError } from "./errors.js";
import { typeNameFor, pascal, tokenize, singularize, pluralize } from "./naming.js";
import { listRule, classifyScalar, countOf } from "./rules.js";
import { checkDirectives, stripDirectives, directiveProps } from "./directives.js";
import { compileSpec, specProps } from "./spec.js";
import { generate, GRAPH_GENERATORS } from "./generators.js";
import { Stream } from "./rng.js";

const BUILTIN_SCALARS = new Set(["Int", "Float", "String", "Boolean", "ID"]);
const PAGING_ARGS = new Set(["first", "last", "limit", "offset", "skip", "take", "page", "after"]);
/** Pass-through scalar for enum literals and other values with no better SDL type. */
export const ANY_SCALAR = "GraceholderAny";

export function graphqlError(error) {
  return new GraceholderError("graphql", error.message, { cause: error, errors: [error] });
}

/** @param {string|import("graphql").DocumentNode} query */
export function toDocument(query) {
  if (typeof query === "string") {
    try {
      return parse(query);
    } catch (e) {
      throw graphqlError(e);
    }
  }
  if (query && typeof query === "object" && query.kind === Kind.DOCUMENT) return query;
  throw new GraceholderError("bad-options", "query must be a string or a DocumentNode");
}

function selectOperation(doc, operationName) {
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  let op;
  if (operationName !== undefined) {
    op = ops.find((o) => o.name?.value === operationName);
    if (!op) throw new GraceholderError("bad-operation", `no operation named ${JSON.stringify(operationName)}`);
  } else if (ops.length === 1) {
    op = ops[0];
  } else {
    throw new GraceholderError("bad-operation", ops.length === 0 ? "the document has no operation" : "the document has several operations; pass operationName");
  }
  if (op.operation !== "query") {
    throw new GraceholderError("bad-operation", `${op.operation} operations are not supported`, { hint: "graceholder generates data for queries only" });
  }
  return op;
}

/** Fragments reachable from the operation, in first-use order. Detects unknown fragments and cycles. */
function reachableFragments(doc, op) {
  const all = new Map(doc.definitions.filter((d) => d.kind === Kind.FRAGMENT_DEFINITION).map((d) => [d.name.value, d]));
  const used = new Map();
  const stack = [];
  const visitSet = (selSet) => {
    for (const s of selSet.selections) {
      if (s.kind === Kind.FRAGMENT_SPREAD) {
        const name = s.name.value;
        if (stack.includes(name)) throw graphqlError(new GraphQLError(`Cannot spread fragment "${name}" within itself.`));
        const def = all.get(name);
        if (!def) throw graphqlError(new GraphQLError(`Unknown fragment "${name}".`));
        if (!used.has(name)) used.set(name, def);
        stack.push(name);
        visitSet(def.selectionSet);
        stack.pop();
      } else if (s.selectionSet) {
        visitSet(s.selectionSet);
      }
    }
  };
  visitSet(op.selectionSet);
  return used;
}

/** Counts that are measures of something other than a sibling collection. */
const MEASURES = new Set(["view", "like", "vote", "dislike", "click", "download", "impression", "visit", "reaction", "page", "word", "character"]);

const camel = (words) => words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");

const withoutBang = (t) => (t.endsWith("!") ? t.slice(0, -1) : t);

/** Field nodes directly in a selection set, looking through every fragment. */
function flattenFields(selSet, fragments, out = []) {
  for (const s of selSet.selections) {
    if (s.kind === Kind.FIELD) out.push(s);
    else if (s.kind === Kind.INLINE_FRAGMENT) flattenFields(s.selectionSet, fragments, out);
    else if (s.kind === Kind.FRAGMENT_SPREAD) flattenFields(fragments.get(s.name.value).selectionSet, fragments, out);
  }
  return out;
}

/** Fields selected outside any type-conditioned fragment (they belong to the abstract type itself). */
function plainFields(selSet, fragments, out = []) {
  for (const s of selSet.selections) {
    if (s.kind === Kind.FIELD && !s.name.value.startsWith("__")) out.push(s);
    else if (s.kind === Kind.INLINE_FRAGMENT && !s.typeCondition) plainFields(s.selectionSet, fragments, out);
  }
  return out;
}

const OV_SOURCE_RANK = { directive: 2, spec: 1 };

/** SDL scalar type of a generator's output. */
export function genSdlType(name, args, packs = []) {
  for (const pack of packs) if (pack.types && Object.hasOwn(pack.types, name)) return pack.types[name];
  if (name === "series.value") return "Float";
  if (name === "series.date") return "DateTime";
  if (["int", "person.age", "count.of"].includes(name) || (name === "id.int" && !args.string)) return "Int";
  if (["float", "money", "percent", "place.lat", "place.lng", "order.subtotal", "order.tax", "order.total"].includes(name)) return "Float";
  if (name === "bool") return "Boolean";
  if (name === "datetime" || name.startsWith("time.")) return "DateTime";
  if (name === "id.key") return "ID";
  if (name === "oneOf" && Array.isArray(args.values)) {
    const vals = args.values.map((v) => (v !== null && typeof v === "object" && "weight" in v ? v.value : v));
    if (vals.every((v) => typeof v === "boolean")) return "Boolean";
    if (vals.every((v) => Number.isInteger(v))) return "Int";
    if (vals.every((v) => typeof v === "number")) return "Float";
  }
  return "String";
}

/** Run a generator once with throwaway streams so unknown names and bad arguments fail at inference time. */
function checkGenerator(name, args, path, packs) {
  if (GRAPH_GENERATORS.includes(name)) return;
  const stream = new Stream(1n);
  try {
    generate(name, { stream, slot: () => new Stream(1n), anchorMs: 0, args, typeName: "T", entityKey: "1", fieldName: "f", packs });
  } catch (e) {
    if (e instanceof GraceholderError && path) e.path = path;
    throw e;
  }
}

class Inferer {
  constructor(op, fragments, config) {
    this.spec = config.spec;
    this.packs = config.packs ?? [];
    this.realistic = Boolean(config.realistic);
    this.variables = config.variables;
    this.nullableTypes = config.nullableTypes;
    this.nullableFields = config.nullableFields;
    this.fragments = fragments;
    this.varTypes = new Map((op.variableDefinitions ?? []).map((v) => [v.variable.name.value, print(v.type)]));
    this.types = new Map(); // typeName -> Map(fieldName -> info)
    this.inputs = new Map(); // inputName -> Map(field -> typeStr)
    this.abstracts = new Map(); // name -> { kind: "union"|"interface", possible: string[] }
    this.synthetic = new Map(); // connection/edge/pageInfo type -> { kind, item }
    this.customScalars = [];
    this.usesDateTime = false;
    this.walked = new Set();
    this.ensureType("Query");
    this.opSeed = directiveProps(op.directives, this.variables, "").seed;
    for (const t of this.varTypes.values()) this.noteNamedType(t);
    this.walk(op.selectionSet, "Query", "");
  }

  ensureType(name) {
    if (!this.types.has(name)) this.types.set(name, new Map());
    return this.types.get(name);
  }

  noteNamedType(typeStr) {
    const named = typeStr.replace(/[[\]!]/g, "");
    if (!BUILTIN_SCALARS.has(named)) this.noteScalar(named);
  }

  noteScalar(name) {
    if (!this.customScalars.includes(name)) this.customScalars.push(name);
  }

  walk(selSet, parentType, path) {
    for (const sel of selSet.selections) {
      if (sel.kind === Kind.FIELD) this.field(sel, parentType, path);
      else if (sel.kind === Kind.INLINE_FRAGMENT) this.walk(sel.selectionSet, parentType, path);
      else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const memo = `${parentType}\u0000${path}\u0000${sel.name.value}`;
        if (this.walked.has(memo)) continue;
        this.walked.add(memo);
        this.walk(this.fragments.get(sel.name.value).selectionSet, parentType, path);
      }
    }
  }

  /** Distinct type conditions applied directly to a field's selection set (N2, S4). */
  explicitTypes(selSet) {
    const found = new Set();
    const look = (set) => {
      for (const s of set.selections) {
        if (s.kind === Kind.INLINE_FRAGMENT) {
          if (s.typeCondition) found.add(s.typeCondition.name.value);
          else look(s.selectionSet);
        } else if (s.kind === Kind.FRAGMENT_SPREAD) {
          found.add(this.fragments.get(s.name.value).typeCondition.name.value);
        }
      }
    };
    look(selSet);
    return [...found];
  }

  /** Combine this occurrence's directive and spec properties into the field's overrides. */
  mergeOverrides(info, directive, spec, path) {
    for (const [source, props] of [["spec", spec], ["directive", directive]]) {
      for (const [prop, value] of Object.entries(props)) {
        const have = info.ov[prop];
        if (have === undefined) {
          info.ov[prop] = value;
          info.ovSrc[prop] = source;
        } else if (JSON.stringify(have) !== JSON.stringify(value)) {
          if (OV_SOURCE_RANK[source] > OV_SOURCE_RANK[info.ovSrc[prop]]) {
            info.ov[prop] = value;
            info.ovSrc[prop] = source;
          } else if (OV_SOURCE_RANK[source] === OV_SOURCE_RANK[info.ovSrc[prop]] && source === "directive") {
            throw new GraceholderError("conflicting-overrides", `field ${info.parentType}.${info.name} has different @${prop === "gen" ? "gen/pattern/pick" : prop} overrides in different places`, { path });
          }
          // equal source and spec: the first (most specific for that path) wins
        }
      }
    }
  }

  /** S3: is this a Relay connection selection? */
  isConnection(node, explicit) {
    if (explicit.length === 1 && explicit[0].endsWith("Connection")) return true;
    const kids = flattenFields(node.selectionSet, this.fragments);
    const withSel = (n) => kids.some((k) => k.name.value === n && k.selectionSet);
    return withSel("edges") || withSel("pageInfo") || (withSel("nodes") && kids.some((k) => k.name.value === "totalCount"));
  }

  synthField(spec, name, parentType, path) {
    const fields = this.ensureType(parentType);
    if (fields.has(name)) return fields.get(name);
    const info = { name, path, parentType, args: new Map(), explicit: false, synthetic: true, ...spec };
    fields.set(name, info);
    if (info.kind === "object") this.ensureType(info.typeName);
    return info;
  }

  field(node, parentType, parentPath) {
    const name = node.name.value;
    if (name.startsWith("__")) return;
    const path = parentPath ? `${parentPath}.${name}` : name;
    const synth = this.synthetic.get(parentType);
    if (synth && SYNTH[synth.kind]?.[name]) {
      const info = this.synthField(SYNTH[synth.kind][name](synth.item), name, parentType, path);
      if (node.selectionSet) this.walk(node.selectionSet, info.typeName, path);
      return;
    }
    const fields = this.ensureType(parentType);
    const hasSel = Boolean(node.selectionSet);
    let info = fields.get(name);
    if (!info) {
      info = { name, path, parentType, kind: hasSel ? "object" : "scalar", args: new Map(), typeName: undefined, explicit: false, ov: {}, ovSrc: {} };
      fields.set(name, info);
    } else if ((info.kind === "object") !== hasSel) {
      throw new GraceholderError("conflicting-shape", `field ${parentType}.${name} is selected both with and without a sub-selection`, { path });
    }
    for (const a of node.arguments ?? []) this.arg(info, a);
    this.mergeOverrides(info, directiveProps(node.directives, this.variables, path), specProps(this.spec, path, parentType, name), path);
    if (!hasSel) return;

    let explicit = this.explicitTypes(node.selectionSet);
    if (info.ov.type !== undefined) explicit = [info.ov.type];
    if (info.typeName !== undefined) {
      if (explicit.length === 1 && explicit[0] !== info.typeName && !info.abstract) {
        throw new GraceholderError("conflicting-shape", `field ${parentType}.${name} is typed ${info.typeName} in one place and ${explicit[0]} in another`, { path });
      }
      if (info.connection) return this.walk(node.selectionSet, info.typeName, path);
      if (info.abstract) return this.walkAbstract(node.selectionSet, info, path);
      return this.walk(node.selectionSet, info.typeName, path);
    }

    if (explicit.length > 1) {
      const plain = plainFields(node.selectionSet, this.fragments);
      const kind = plain.length > 0 ? "interface" : "union";
      info.typeName = typeNameFor(name) + (kind === "union" ? "Union" : "");
      info.abstract = { kind, possible: explicit };
      info.explicit = true;
      this.abstracts.set(info.typeName, info.abstract);
      for (const t of explicit) this.ensureType(t);
      if (kind === "interface") this.ensureType(info.typeName);
      return this.walkAbstract(node.selectionSet, info, path);
    }

    if (this.isConnection(node, explicit)) {
      let itemType;
      let connType;
      if (explicit.length === 1 && explicit[0].endsWith("Connection")) {
        connType = explicit[0];
        itemType = connType.slice(0, -"Connection".length) || "Node";
      } else {
        const tokens = tokenize(name);
        if (tokens.length > 1 && tokens[tokens.length - 1] === "connection") tokens.pop();
        itemType = info.ov.type ?? typeNameFor(tokens.join("_"));
        connType = `${itemType}Connection`;
      }
      info.typeName = connType;
      info.connection = { item: itemType };
      info.explicit = explicit.length === 1;
      this.synthetic.set(connType, { kind: "connection", item: itemType });
      this.synthetic.set(`${itemType}Edge`, { kind: "edge", item: itemType });
      this.synthetic.set("PageInfo", { kind: "pageInfo", item: itemType });
      this.ensureType(connType);
      this.ensureType(itemType);
      return this.walk(node.selectionSet, connType, path);
    }

    info.typeName = explicit.length === 1 ? explicit[0] : typeNameFor(name);
    info.explicit = explicit.length === 1;
    this.ensureType(info.typeName);
    this.walk(node.selectionSet, info.typeName, path);
  }

  /** Walk the selection of a union/interface field: plain fields to the interface and each member, fragments to their type. */
  walkAbstract(selSet, info, path) {
    const { kind, possible } = info.abstract;
    const visit = (set) => {
      for (const s of set.selections) {
        if (s.kind === Kind.FIELD) {
          if (kind === "interface") this.field(s, info.typeName, path);
          for (const t of possible) this.field(s, t, path);
        } else if (s.kind === Kind.INLINE_FRAGMENT) {
          if (s.typeCondition) this.walk(s.selectionSet, s.typeCondition.name.value, path);
          else visit(s.selectionSet);
        } else if (s.kind === Kind.FRAGMENT_SPREAD) {
          const def = this.fragments.get(s.name.value);
          this.walk(def.selectionSet, def.typeCondition.name.value, path);
        }
      }
    };
    visit(selSet);
  }

  arg(info, a) {
    const argName = a.name.value;
    const list = info.args.get(argName) ?? [];
    list.push({ type: this.valueType(a.value, `${pascal(tokenize(info.name))}${pascal(tokenize(argName))}`), isList: a.value.kind === Kind.LIST });
    info.args.set(argName, list);
  }

  valueType(v, inputName) {
    switch (v.kind) {
      case Kind.INT: return "Int";
      case Kind.FLOAT: return "Float";
      case Kind.STRING: return "String";
      case Kind.BOOLEAN: return "Boolean";
      case Kind.NULL: return "String";
      case Kind.ENUM: this.noteScalar(ANY_SCALAR); return ANY_SCALAR;
      case Kind.VARIABLE: {
        const t = this.varTypes.get(v.name.value);
        if (t) return t;
        this.noteScalar(ANY_SCALAR);
        return ANY_SCALAR;
      }
      case Kind.LIST: {
        if (v.values.length === 0) { this.noteScalar(ANY_SCALAR); return `[${ANY_SCALAR}]`; }
        return `[${withoutBang(this.valueType(v.values[0], inputName))}]`;
      }
      case Kind.OBJECT: {
        if (v.fields.length === 0) { this.noteScalar(ANY_SCALAR); return ANY_SCALAR; }
        const name = `${inputName}Input`;
        const fields = this.inputs.get(name) ?? new Map();
        this.inputs.set(name, fields);
        for (const f of v.fields) {
          if (!fields.has(f.name.value)) {
            fields.set(f.name.value, withoutBang(this.valueType(f.value, `${inputName}${pascal(tokenize(f.name.value))}`)));
          }
        }
        return name;
      }
      default: return "String";
    }
  }

  /** Apply L/T rules to every field once all occurrences are merged. */
  finalize() {
    const decisions = [];
    const users = new Map(); // object type -> number of fields that reference it
    for (const fields of this.types.values()) {
      for (const info of fields.values()) if (info.kind === "object" && !info.synthetic) users.set(info.typeName, (users.get(info.typeName) ?? 0) + 1);
    }
    for (const [typeName, fields] of this.types) {
      for (const info of fields.values()) {
        if (info.synthetic) {
          if (info.kind === "scalar" && info.sdl === "DateTime") this.usesDateTime = true;
          continue;
        }
        const argNames = [...info.args.keys()];
        if (info.connection) {
          if (info.ov.list !== undefined) throw new GraceholderError("conflicting-overrides", `${info.parentType}.${info.name} is a connection; @list/@one do not apply`, { path: info.path });
          info.list = false;
          decisions.push({ path: info.path, field: info.name, kind: "type", value: info.typeName, source: "heuristic", rule: "S3" });
        } else if (info.abstract) {
          info.list = info.ov.list ?? listRule(info.name, { paging: argNames.some((n) => PAGING_ARGS.has(n)), idsArg: argNames.includes("ids"), listLiteralArg: false, realistic: this.realistic, object: true }).list;
          decisions.push({ path: info.path, field: info.name, kind: "type", value: info.typeName, source: "heuristic", rule: "S4" });
        } else {
          const rule = listRule(info.name, {
            paging: argNames.some((n) => PAGING_ARGS.has(n)),
            idsArg: argNames.includes("ids"),
            listLiteralArg: [...info.args.values()].some((u) => u.some((x) => x.isList || x.type.startsWith("["))),
            realistic: this.realistic,
            object: info.kind === "object",
          });
          let list = info.kind === "scalar" && countOf(info.name) ? false : rule.list; // a count is a number
          let listRuleId = rule.rule;
          let listSource = rule.rule === "L6" ? "default" : "heuristic";
          if (info.ov.list !== undefined) {
            list = info.ov.list;
            listRuleId = "L1";
            listSource = info.ovSrc.list;
          }
          info.list = list;
          decisions.push({ path: info.path, field: info.name, kind: "list", value: list, source: listSource, rule: listRuleId });
          if (info.kind === "object") {
            decisions.push({ path: info.path, field: info.name, kind: "type", value: info.typeName, source: info.ov.type ? info.ovSrc.type : "heuristic", rule: info.ov.type ? "N1" : info.explicit ? "N2" : "N3" });
            if ((users.get(info.typeName) ?? 0) > 1 && !info.ov.own) {
              decisions.push({ path: info.path, field: info.name, kind: "object", value: `pool:${info.typeName}`, source: "default", rule: "E2-shared" });
            }
          }
        }
        if (info.kind === "scalar") {
          const c = classifyScalar(info.name, { typeName, list: info.list, packs: this.packs, realistic: this.realistic });
          info.sdl = c.sdl;
          info.gen = c.gen;
          info.genArgs = c.args;
          info.nullable = c.nullable;
          if (c.sdl === "DateTime") this.usesDateTime = true;
          info.decision = { path: info.path, field: info.name, kind: "scalar", value: c.sdl, source: c.rule === "T13" ? "default" : "heuristic", rule: c.rule };
          decisions.push(info.decision);
        }
        for (const [argName, usages] of info.args) {
          decisions.push({ path: info.path, field: info.name, kind: "arg", value: `${argName}: ${argType(usages)}`, source: "heuristic" });
        }
      }
    }
    this.applyOverrides(decisions);
    this.countFields();
    this.resolveDerives();
    for (const entry of this.spec.entries) {
      if (!entry.used) decisions.push({ path: entry.key, field: entry.key.split(".").pop(), kind: "unused", value: null, source: "spec", rule: "unused-spec-path" });
    }
    return decisions;
  }

  /** Apply gen/pattern/pick, count, nullRate, derive, key, own, shared and seed overrides. */
  applyOverrides(decisions) {
    const conflict = (info, msg) => new GraceholderError("conflicting-overrides", `${info.parentType}.${info.name}: ${msg}`, { path: info.path });
    for (const fields of this.types.values()) {
      for (const info of fields.values()) {
        if (info.synthetic) continue;
        const { ov, ovSrc: src } = info;
        const push = (kind, value, rule, prop) => decisions.push({ path: info.path, field: info.name, kind, value, source: src[prop], rule });
        if (ov.gen !== undefined) {
          if (info.kind !== "scalar") throw conflict(info, "@gen/@pattern/@pick apply to scalar fields only");
          checkGenerator(ov.gen.name, ov.gen.args, info.path, this.packs);
          info.gen = ov.gen.name;
          info.genArgs = ov.gen.args;
          info.sdl = genSdlType(ov.gen.name, ov.gen.args, this.packs);
          info.nullable = ov.gen.name === "time.deleted" && (ov.gen.args.nullRate ?? 1) >= 1 ? true : undefined;
          if (info.sdl === "DateTime") this.usesDateTime = true;
          Object.assign(info.decision, { value: info.sdl, source: src.gen, rule: "gen" });
        }
        if (ov.count !== undefined) {
          if (!info.list && !info.connection) throw conflict(info, "@count needs a list (add @list, or use a plural field name)");
          info.count = ov.count;
          push("count", ov.count.n !== undefined ? ov.count.n : [ov.count.min, ov.count.max], "C1", "count");
        }
        if (ov.nullRate !== undefined) {
          info.nullRate = ov.nullRate;
          info.nullable = ov.nullRate > 0 ? true : info.nullable;
          push("null", ov.nullRate, "nullRate", "nullRate");
        }
        if (ov.derive !== undefined) {
          if (info.kind !== "scalar") throw conflict(info, "@derive applies to scalar fields only");
          info.derive = ov.derive;
        }
        if (ov.key !== undefined) { info.keyArgs = ov.key; push("key", ov.key, "key", "key"); }
        if (ov.own !== undefined) info.own = ov.own;
        if (ov.shared !== undefined) info.shared = ov.shared;
        if (ov.seed !== undefined) { info.seed = ov.seed; push("seed", ov.seed, "seed", "seed"); }
      }
    }
  }

  /** @derive: the source must be a scalar of the same type, and derivations must not form a cycle. */
  resolveDerives() {
    for (const [typeName, fields] of this.types) {
      for (const info of fields.values()) {
        if (info.derive === undefined) continue;
        const seen = [info.name];
        let cur = info;
        while (cur?.derive !== undefined) {
          const next = fields.get(cur.derive);
          if (cur.derive === info.name || seen.includes(cur.derive)) {
            throw new GraceholderError("bad-derive", `@derive cycle on ${typeName}: ${[...seen, cur.derive].join(" -> ")}`, { path: info.path });
          }
          if (next && next.kind !== "scalar") throw new GraceholderError("bad-derive", `${typeName}.${info.name} derives from ${cur.derive}, which is not a scalar field`, { path: info.path });
          seen.push(cur.derive);
          cur = next;
        }
        const src = fields.get(info.derive);
        info.sdl = src ? src.sdl : classifyScalar(info.derive, { typeName, list: false, packs: this.packs, realistic: this.realistic }).sdl;
        if (info.sdl === "DateTime") this.usesDateTime = true;
        info.list = false;
        info.nullable = info.nullRate > 0 ? true : undefined;
        Object.assign(info.decision, { value: info.sdl, source: info.ovSrc.derive, rule: "derive" });
      }
    }
  }

  /** `<x>Count` / `total<X>s` equal the total of the sibling collection `<x>s` (docs/design.md 6.2). */
  countFields() {
    for (const fields of this.types.values()) {
      for (const info of fields.values()) {
        if (info.synthetic || info.kind !== "scalar" || info.list) continue;
        const words = countOf(info.name);
        if (!words) continue;
        const want = words.join("_");
        let sibling;
        for (const other of fields.values()) {
          if (other === info || other.synthetic || !other.list) continue;
          const t = tokenize(other.name);
          t[t.length - 1] = singularize(t[t.length - 1]);
          if (t.join("_") === want) sibling = other;
        }
        if (info.ov.gen !== undefined || info.ov.derive !== undefined) continue;
        if (!sibling && MEASURES.has(words[words.length - 1])) continue;
        const target = sibling ? sibling.name : camel([...words.slice(0, -1), pluralize(words[words.length - 1])]);
        info.sdl = "Int";
        info.gen = "count.of";
        info.genArgs = { of: target };
        Object.assign(info.decision, { value: "Int", rule: "C-count", source: "heuristic" });
      }
    }
  }

  sdl() {
    const out = [];
    const scalars = [];
    if (this.usesDateTime) scalars.push("DateTime");
    scalars.push(...this.customScalars);
    if (scalars.length) out.push(scalars.map((s) => `scalar ${s}`).join("\n"));
    const implementsOf = new Map();
    for (const [name, a] of this.abstracts) {
      if (a.kind === "interface") for (const t of a.possible) implementsOf.set(t, [...(implementsOf.get(t) ?? []), name]);
    }
    for (const [typeName, fields] of this.types) {
      const lines = [];
      for (const info of fields.values()) {
        const args = [...info.args.entries()].map(([n, u]) => `${n}: ${argType(u)}`);
        const argText = args.length ? `(${args.join(", ")})` : "";
        const base = info.kind === "object" ? info.typeName : info.sdl;
        let type = info.list ? `[${base}!]!` : `${base}!`;
        // a world with deletions: a singular reference to a deleted entity resolves to null
        if (info.nullable || this.nullableFields?.has(`${typeName}.${info.name}`) || (this.nullableTypes && info.kind === "object" && !info.list && !info.connection && !info.abstract && this.nullableTypes.has(info.typeName))) type = type.replace(/!$/, "");
        lines.push(`  ${info.name}${argText}: ${type}`);
      }
      if (lines.length === 0) lines.push("  _empty: String");
      const abstract = this.abstracts.get(typeName);
      const impl = implementsOf.get(typeName);
      const head = abstract?.kind === "interface" ? `interface ${typeName}` : `type ${typeName}${impl ? ` implements ${impl.join(" & ")}` : ""}`;
      out.push(`${head} {\n${lines.join("\n")}\n}`);
    }
    for (const [name, a] of this.abstracts) {
      if (a.kind === "union") out.push(`union ${name} = ${a.possible.join(" | ")}`);
    }
    for (const [name, fields] of this.inputs) {
      out.push(`input ${name} {\n${[...fields].map(([n, t]) => `  ${n}: ${t}`).join("\n")}\n}`);
    }
    return out.join("\n\n") + "\n";
  }
}

/** Fixed shapes of the Relay types (docs/design.md 3.4). */
const SYNTH = {
  connection: {
    edges: (item) => ({ kind: "object", list: true, typeName: `${item}Edge`, special: "edges" }),
    nodes: (item) => ({ kind: "object", list: true, typeName: item, special: "nodes" }),
    pageInfo: () => ({ kind: "object", list: false, typeName: "PageInfo", special: "pageInfo" }),
    totalCount: () => ({ kind: "scalar", list: false, sdl: "Int", special: "totalCount" }),
  },
  edge: {
    cursor: () => ({ kind: "scalar", list: false, sdl: "String", special: "cursor" }),
    node: (item) => ({ kind: "object", list: false, typeName: item, special: "edgeNode" }),
  },
  pageInfo: {
    hasNextPage: () => ({ kind: "scalar", list: false, sdl: "Boolean", special: "pageInfoField" }),
    hasPreviousPage: () => ({ kind: "scalar", list: false, sdl: "Boolean", special: "pageInfoField" }),
    startCursor: () => ({ kind: "scalar", list: false, sdl: "String", nullable: true, special: "pageInfoField" }),
    endCursor: () => ({ kind: "scalar", list: false, sdl: "String", nullable: true, special: "pageInfoField" }),
  },
};

/** One type for an argument seen several times: identical, else the nullable form of the first. */
function argType(usages) {
  const first = usages[0].type;
  return usages.every((u) => u.type === first) ? first : withoutBang(first);
}

/**
 * @param {string|import("graphql").DocumentNode} query
 * @param {{ operationName?: string, spec?: any, compiledSpec?: any, variables?: Record<string, unknown>, strict?: boolean, nullableTypes?: Set<string>, nullableFields?: Set<string>, packs?: any[], realistic?: boolean }} [options]
 */
export function infer(query, options = {}) {
  const doc = toDocument(query);
  const op = selectOperation(doc, options.operationName);
  const fragments = reachableFragments(doc, op);
  checkDirectives([op, ...fragments.values()]);
  const spec = options.compiledSpec ?? compileSpec(options.spec);
  const variables = operationVariables(op, options.variables);
  const inf = new Inferer(op, fragments, { spec, variables, nullableTypes: options.nullableTypes, nullableFields: options.nullableFields, packs: options.packs, realistic: options.realistic });
  const decisions = inf.finalize();
  if (options.strict) {
    const unused = decisions.find((d) => d.kind === "unused");
    if (unused) throw new GraceholderError("unused-spec-path", `spec path ${JSON.stringify(unused.path)} matches no field in the operation`, { path: unused.path });
  }
  /** @type {import("graphql").DocumentNode} */
  const document = { kind: Kind.DOCUMENT, definitions: [dropDirectiveOnlyVariables(op, fragments, stripDirectives(op)), ...[...fragments.values()].map(stripDirectives)] };
  const model = new Map();
  for (const [typeName, fields] of inf.types) model.set(typeName, fields);
  return { sdl: inf.sdl(), decisions, document, model, abstracts: inf.abstracts, opSeed: inf.opSeed, spec };
}

/** Variables that only graceholder directives referenced are not variables of the stripped document. */
function dropDirectiveOnlyVariables(op, fragments, stripped) {
  const used = new Set();
  const collect = (node) => visit(node, { VariableDefinition: () => false, Variable(v) { used.add(v.name.value); } });
  collect(stripped);
  for (const f of fragments.values()) collect(stripDirectives(f));
  const defs = (stripped.variableDefinitions ?? []).filter((d) => used.has(d.variable.name.value));
  return { ...stripped, variableDefinitions: defs };
}

/** Variable values for directive arguments: provided values over declared defaults. */
function operationVariables(op, provided = {}) {
  const out = {};
  for (const def of op.variableDefinitions ?? []) {
    if (def.defaultValue) {
      // defaults are plain literals here; richer coercion happens at execution
      out[def.variable.name.value] = JSON.parse(JSON.stringify(valueFromASTUntyped(def.defaultValue)));
    }
  }
  return { ...out, ...provided };
}
