// Inline directives (docs/design.md 5.1): parsed into the same override properties as the
// side-car spec, then stripped from the document before validation and execution.
import { valueFromASTUntyped, Kind, visit } from "graphql";
import { GraceholderError } from "./errors.js";
import { normalizeCount, checkPick } from "./spec.js";

export const BUILTIN_DIRECTIVES = new Set(["skip", "include"]);
export const DIRECTIVES = ["list", "one", "count", "gen", "pattern", "pick", "nullRate", "derive", "type", "seed"];

const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

export const nearest = (name, names) => [...names].sort((x, y) => lev(name, x) - lev(name, y))[0];

function unknownDirective(name) {
  const near = nearest(name, DIRECTIVES);
  return new GraceholderError("unknown-directive", `unknown directive @${name}`, {
    hint: `did you mean @${near}? Known: ${DIRECTIVES.map((d) => `@${d}`).join(", ")}, @skip, @include`,
  });
}

/** Throw for any directive that is neither built in nor ours, and for graceholder directives outside fields. */
export function checkDirectives(roots) {
  for (const root of roots) {
    visit(root, {
      Directive(node, _key, _parent, _path, /** @type {any} */ ancestors) {
        const name = node.name.value;
        if (BUILTIN_DIRECTIVES.has(name)) return;
        if (!DIRECTIVES.includes(name)) throw unknownDirective(name);
        const owner = ancestors[ancestors.length - 1];
        const holder = Array.isArray(owner) ? ancestors[ancestors.length - 2] : owner;
        const ok = holder?.kind === Kind.FIELD || (holder?.kind === Kind.OPERATION_DEFINITION && name === "seed");
        if (!ok) {
          throw new GraceholderError("unknown-directive", `@${name} is not allowed here`, { hint: name === "seed" ? "@seed goes on a field or the operation" : `@${name} goes on a field` });
        }
      },
    });
  }
}

/** Remove graceholder directives (keeps @skip and @include). */
export function stripDirectives(node) {
  return visit(node, {
    Directive(d) {
      return BUILTIN_DIRECTIVES.has(d.name.value) ? undefined : null;
    },
  });
}

/**
 * @param {readonly import("graphql").DirectiveNode[]} directives
 * @param {Record<string, unknown>} variables
 * @param {string} path
 * @returns {Record<string, any>} override properties (same shape as a compiled spec entry)
 */
export function directiveProps(directives, variables, path) {
  const props = {};
  const fail = (code, name, msg) => new GraceholderError(code, `@${name}: ${msg}`, { path });
  const badDir = (name) => (msg) => fail("bad-directive", name, msg);
  const set = (prop, value, name) => {
    if (props[prop] !== undefined && JSON.stringify(props[prop]) !== JSON.stringify(value)) {
      throw fail("conflicting-overrides", name, `conflicts with another directive on the same field (${prop})`);
    }
    if (props[prop] !== undefined) throw fail("conflicting-overrides", name, `appears more than once on the same field`);
    props[prop] = value;
  };
  for (const d of directives ?? []) {
    const name = d.name.value;
    if (BUILTIN_DIRECTIVES.has(name)) continue;
    const args = {};
    for (const a of d.arguments ?? []) args[a.name.value] = valueFromASTUntyped(a.value, variables);
    const only = (...allowed) => {
      for (const k of Object.keys(args)) if (!allowed.includes(k)) throw fail("bad-directive", name, `unknown argument ${JSON.stringify(k)} (expected ${allowed.join(", ") || "none"})`);
    };
    const fb = badDir(name);
    switch (name) {
      case "list": only(); set("list", true, name); break;
      case "one": only(); set("one", true, name); break;
      case "count": {
        only("n", "min", "max");
        const value = args.n !== undefined ? args.n : [args.min, args.max];
        if (args.n !== undefined && (args.min !== undefined || args.max !== undefined)) throw fb("use n, or min and max, not both");
        set("count", normalizeCount(value, fb), name);
        break;
      }
      case "gen": {
        const { name: genName, ...rest } = args;
        if (typeof genName !== "string") throw fb("name must be a string");
        set("gen", { name: genName, args: rest }, name);
        break;
      }
      case "pattern": only("p"); if (typeof args.p !== "string") throw fb("p must be a string"); set("gen", { name: "pattern", args: { p: args.p } }, name); break;
      case "pick": only("values"); set("gen", { name: "oneOf", args: { values: checkPick(args.values, fb) } }, name); break;
      case "nullRate":
        only("p");
        if (typeof args.p !== "number" || !(args.p >= 0 && args.p <= 1)) throw fb("p must be a number between 0 and 1");
        set("nullRate", args.p, name);
        break;
      case "derive": only("from"); if (typeof args.from !== "string" || !args.from) throw fb("from must be a field name"); set("derive", args.from, name); break;
      case "type": only("name"); if (typeof args.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.name)) throw fb("name must be a GraphQL type name"); set("type", args.name, name); break;
      case "seed": only("s"); if (typeof args.s !== "string" && typeof args.s !== "number") throw fb("s must be a string or number"); set("seed", String(args.s), name); break;
      default: throw unknownDirective(name);
    }
  }
  if (props.list && props.one) throw new GraceholderError("conflicting-overrides", "@list and @one on the same field", { path });
  if (props.one) props.list = false;
  delete props.one;
  return props;
}
