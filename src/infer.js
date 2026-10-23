// Schema inference from a query (docs/design.md section 4): walk the selected
// operation, merge every (parentType, fieldName), apply the L/N/T rules, emit SDL.
import { parse, Kind, print, visit, GraphQLError } from "graphql";
import { GraceholderError } from "./errors.js";
import { typeNameFor, pascal, tokenize } from "./naming.js";
import { listRule, classifyScalar } from "./rules.js";

const BUILTIN_SCALARS = new Set(["Int", "Float", "String", "Boolean", "ID"]);
const PAGING_ARGS = new Set(["first", "last", "limit", "offset", "skip", "take", "page", "after"]);
const KNOWN_DIRECTIVES = new Set(["skip", "include"]);
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

function checkDirectives(nodes) {
  for (const root of nodes) {
    visit(root, {
      Directive(node) {
        if (!KNOWN_DIRECTIVES.has(node.name.value)) {
          throw new GraceholderError("unknown-directive", `unknown directive @${node.name.value}`, {
            hint: "known directives: @skip, @include (graceholder's own directives arrive in a later release)",
          });
        }
      },
    });
  }
}

const withoutBang = (t) => (t.endsWith("!") ? t.slice(0, -1) : t);

class Inferer {
  constructor(op, fragments) {
    this.fragments = fragments;
    this.varTypes = new Map((op.variableDefinitions ?? []).map((v) => [v.variable.name.value, print(v.type)]));
    this.types = new Map(); // typeName -> Map(fieldName -> info)
    this.inputs = new Map(); // inputName -> Map(field -> typeStr)
    this.customScalars = [];
    this.usesDateTime = false;
    this.walked = new Set();
    this.ensureType("Query");
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

  /** The single type condition applied directly to a field's selection set, if any (N2). */
  explicitType(selSet, field) {
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
    if (found.size > 1) {
      throw new GraceholderError("unsupported", `field ${field} selects several concrete types (${[...found].join(", ")})`, {
        hint: "unions and interfaces arrive in a later release",
      });
    }
    return found.size === 1 ? [...found][0] : undefined;
  }

  field(node, parentType, parentPath) {
    const name = node.name.value;
    if (name.startsWith("__")) return;
    const fields = this.ensureType(parentType);
    const path = parentPath ? `${parentPath}.${name}` : name;
    const hasSel = Boolean(node.selectionSet);
    let info = fields.get(name);
    if (!info) {
      info = { name, path, parentType, kind: hasSel ? "object" : "scalar", args: new Map(), typeName: undefined, explicit: false };
      fields.set(name, info);
    } else if ((info.kind === "object") !== hasSel) {
      throw new GraceholderError("conflicting-shape", `field ${parentType}.${name} is selected both with and without a sub-selection`, { path });
    }
    for (const a of node.arguments ?? []) this.arg(info, a);
    if (!hasSel) return;

    const explicit = this.explicitType(node.selectionSet, path);
    if (info.typeName === undefined) {
      info.typeName = explicit ?? typeNameFor(name);
      info.explicit = explicit !== undefined;
    } else if (explicit !== undefined && explicit !== info.typeName) {
      throw new GraceholderError("conflicting-shape", `field ${parentType}.${name} is typed ${info.typeName} in one place and ${explicit} in another`, { path });
    }
    this.ensureType(info.typeName);
    this.walk(node.selectionSet, info.typeName, path);
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
    for (const [typeName, fields] of this.types) {
      for (const info of fields.values()) {
        const argNames = [...info.args.keys()];
        const rule = listRule(info.name, {
          paging: argNames.some((n) => PAGING_ARGS.has(n)),
          idsArg: argNames.includes("ids"),
          listLiteralArg: [...info.args.values()].some((u) => u.some((x) => x.isList || x.type.startsWith("["))),
        });
        info.list = rule.list;
        decisions.push({ path: info.path, field: info.name, kind: "list", value: rule.list, source: rule.rule === "L6" ? "default" : "heuristic", rule: rule.rule });
        if (info.kind === "object") {
          decisions.push({ path: info.path, field: info.name, kind: "type", value: info.typeName, source: "heuristic", rule: info.explicit ? "N2" : "N3" });
        } else {
          const c = classifyScalar(info.name, { typeName, list: info.list });
          info.sdl = c.sdl;
          info.gen = c.gen;
          info.genArgs = c.args;
          if (c.sdl === "DateTime") this.usesDateTime = true;
          decisions.push({ path: info.path, field: info.name, kind: "scalar", value: c.sdl, source: c.rule === "T13" ? "default" : "heuristic", rule: c.rule });
        }
        for (const [argName, usages] of info.args) {
          decisions.push({ path: info.path, field: info.name, kind: "arg", value: `${argName}: ${argType(usages)}`, source: "heuristic" });
        }
      }
    }
    return decisions;
  }

  sdl() {
    const out = [];
    const scalars = [];
    if (this.usesDateTime) scalars.push("DateTime");
    scalars.push(...this.customScalars);
    if (scalars.length) out.push(scalars.map((s) => `scalar ${s}`).join("\n"));
    for (const [typeName, fields] of this.types) {
      const lines = [];
      for (const info of fields.values()) {
        const args = [...info.args.entries()].map(([n, u]) => `${n}: ${argType(u)}`);
        const argText = args.length ? `(${args.join(", ")})` : "";
        const base = info.kind === "object" ? info.typeName : info.sdl;
        const type = info.list ? `[${base}!]!` : `${base}!`;
        lines.push(`  ${info.name}${argText}: ${type}`);
      }
      if (lines.length === 0) lines.push("  _empty: String");
      out.push(`type ${typeName} {\n${lines.join("\n")}\n}`);
    }
    for (const [name, fields] of this.inputs) {
      out.push(`input ${name} {\n${[...fields].map(([n, t]) => `  ${n}: ${t}`).join("\n")}\n}`);
    }
    return out.join("\n\n") + "\n";
  }
}

/** One type for an argument seen several times: identical, else the nullable form of the first. */
function argType(usages) {
  const first = usages[0].type;
  return usages.every((u) => u.type === first) ? first : withoutBang(first);
}

/**
 * @param {string|import("graphql").DocumentNode} query
 * @param {{ operationName?: string }} [options]
 */
export function infer(query, options = {}) {
  const doc = toDocument(query);
  const op = selectOperation(doc, options.operationName);
  const fragments = reachableFragments(doc, op);
  checkDirectives([op, ...fragments.values()]);
  const inf = new Inferer(op, fragments);
  const decisions = inf.finalize();
  /** @type {import("graphql").DocumentNode} */
  const document = { kind: Kind.DOCUMENT, definitions: [op, ...fragments.values()] };
  const model = new Map();
  for (const [typeName, fields] of inf.types) model.set(typeName, fields);
  return { sdl: inf.sdl(), decisions, document, model };
}
