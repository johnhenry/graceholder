// Type-level reading of a query string (docs/design.md section 20): `ResultOf<"{ users { id name } }">`.
//
// This file mirrors the runtime rules of docs/design.md section 4 (L, N and T rules) for the
// default inference (no schema, no packs, `distributions: "uniform"`). It is a parser written in
// template literal types: a tokenizer, a stack machine for selection sets, and an evaluator.
// What cannot be inferred falls back to `unknown`; a query that cannot be parsed gives `Data`.
//
// The file is self-contained on purpose: `npm run typecheck` checks it with skipLibCheck off.
import type { GeneratorTypes } from "./generator-types.js";

// ---- tokenizer ----------------------------------------------------------------------------------

type WS = " " | "\n" | "\t" | "\r" | "," | "﻿";
type Lower = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";
type Upper = Uppercase<Lower>;
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type NameChar = Lower | Upper | Digit | "_" | "-" | "+" | ".";
type Punct = "{" | "}" | "(" | ")" | "[" | "]" | ":" | "@" | "!" | "=" | "|" | "&";

type SkipWS<S extends string> = S extends `${WS}${infer R}` ? SkipWS<R> : S;
type SkipLine<S extends string> = S extends `${string}\n${infer R}` ? R : "";
type ReadName<S extends string, N extends string = ""> = S extends `${infer C}${infer R}` ? (C extends NameChar ? ReadName<R, `${N}${C}`> : [N, S]) : [N, ""];
type ReadStr<S extends string, Acc extends string = ""> = S extends `${infer B}"${infer R}`
  ? B extends `${string}\\`
    ? ReadStr<R, `${Acc}${B}"`>
    : [`${Acc}${B}`, R]
  : [Acc, ""];

/**
 * The next token and the rest of the text; the token is null at the end. Punctuation is itself, names
 * and numbers are text, strings are `"text`, variables are `$name`. The parser pulls tokens one at a
 * time from the text (a long tuple of tokens costs quadratic memory in the compiler).
 */
type Tok1<S extends string> = SkipWS<S> extends infer T extends string
  ? T extends ""
    ? [null, ""]
    : T extends `#${infer C}`
      ? Tok1<SkipLine<C>>
      : T extends `...${infer R}`
        ? ["...", R]
        : T extends `"""${infer R}`
          ? R extends `${infer B}"""${infer R2}`
            ? [`"${B}`, R2]
            : [null, ""]
          : T extends `"${infer R}`
            ? ReadStr<R> extends [infer B extends string, infer R2 extends string]
              ? [`"${B}`, R2]
              : [null, ""]
            : T extends `$${infer R}`
              ? ReadName<R> extends [infer N extends string, infer R2 extends string]
                ? [`$${N}`, R2]
                : [null, ""]
              : T extends `${infer C}${infer R}`
                ? C extends Punct
                  ? [C, R]
                  : C extends NameChar
                    ? ReadName<T> extends [infer N extends string, infer R2 extends string]
                      ? [N, R2]
                      : [null, ""]
                    : Tok1<R>
                : [null, ""]
  : [null, ""];


// ---- names: tokenize, singularize, PascalCase (src/naming.js) ---------------------------------

type IsUpper<C extends string> = C extends Uppercase<C> ? (C extends Lowercase<C> ? false : true) : false;
type IsLowerLetter<C extends string> = C extends Lower ? true : false;
type Alnum = Lower | Upper | Digit;
type Push<Acc extends string[], Cur extends string> = Cur extends "" ? Acc : [...Acc, Lowercase<Cur>];

/** Prev: "l" lower or digit, "u" upper, "s" start or separator. */
type Words<N extends string, Cur extends string = "", Prev extends "l" | "u" | "s" = "s", Acc extends string[] = []> = N extends `${infer C}${infer R}`
  ? C extends Alnum
    ? IsUpper<C> extends true
      ? Prev extends "l"
        ? Words<R, C, "u", Push<Acc, Cur>>
        : Prev extends "u"
          ? R extends `${infer N1}${string}`
            ? IsLowerLetter<N1> extends true
              ? Words<R, C, "u", Push<Acc, Cur>>
              : Words<R, `${Cur}${C}`, "u", Acc>
            : Words<R, `${Cur}${C}`, "u", Acc>
          : Words<R, `${Cur}${C}`, "u", Acc>
      : Words<R, `${Cur}${C}`, "l", Acc>
    : Words<R, "", "s", Push<Acc, Cur>>
  : Push<Acc, Cur>;

type IrregularSingular = {
  people: "person"; men: "man"; women: "woman"; children: "child"; mice: "mouse"; feet: "foot"; teeth: "tooth"; geese: "goose";
  analyses: "analysis"; indices: "index"; criteria: "criterion"; knives: "knife"; wives: "wife"; leaves: "leaf"; lives: "life";
  shelves: "shelf"; wolves: "wolf"; data: "data"; movies: "movie"; cookies: "cookie"; pies: "pie"; ties: "tie"; lies: "lie";
  zombies: "zombie"; selfies: "selfie"; rookies: "rookie"; calories: "calorie"; species: "species"; series: "series";
};
type Vowel = "a" | "e" | "i" | "o" | "u";
type Singular<W extends string> = W extends keyof IrregularSingular
  ? IrregularSingular[W]
  : W extends `${infer P}ies`
    ? P extends `${string}${Vowel}`
      ? SingularRest<W>
      : P extends ""
        ? SingularRest<W>
        : `${P}y`
    : SingularRest<W>;
type SingularRest<W extends string> = W extends `${string}${"ss" | "x" | "ch" | "sh"}es`
  ? W extends `${infer P}es`
    ? P
    : W
  : W extends `${string}${"ss" | "us" | "is"}`
    ? W
    : W extends `${infer P}s`
      ? P
      : W;

type Last<T extends string[]> = T extends [...string[], infer L extends string] ? L : never;
type Init<T extends string[]> = T extends [...infer I extends string[], string] ? I : [];
type SingularLast<T extends string[]> = [...Init<T>, Singular<Last<T>>];
type Pascal<T extends string[], Acc extends string = ""> = T extends [infer H extends string, ...infer R extends string[]] ? Pascal<R, `${Acc}${Capitalize<H>}`> : Acc;
type Reserved = "Int" | "Float" | "String" | "Boolean" | "ID" | "DateTime" | "Query" | "Mutation" | "Subscription";
type FixType<N extends string> = N extends `${Digit}${string}` ? `T${N}` : N extends Reserved ? `${N}Type` : N;
/** Rule N3: the type name of an object field (`blogPosts` is `BlogPost`). */
type TypeNameOf<Name extends string> = Words<Name> extends infer T extends string[] ? (T extends [] ? "Object" : FixType<Pascal<SingularLast<T>>>) : never;

// ---- the L and T rules (src/rules.js) ----------------------------------------------------------

type IrregularPlural = "people" | "children" | "men" | "women" | "mice";
type SingularPlural = "views" | "likes" | "votes" | "dislikes" | "news" | "series" | "species";
type PluralLast<W extends string> = W extends SingularPlural ? false : W extends IrregularPlural ? true : W extends "data" ? false : W extends `${string}${"ss" | "us" | "is"}` ? false : W extends `${string}s` ? true : false;
type PagingArg = "first" | "last" | "limit" | "offset" | "skip" | "take" | "page" | "after";

/** `<x>Count`, `total<X>s` (docs/design.md 6.2): counts of a sibling collection are numbers. */
type CountOf<T extends string[], L extends string = Last<T>> = T extends [infer First, ...infer Rest extends string[]]
  ? Rest extends []
    ? false
    : L extends "count"
      ? true
      : First extends "total"
        ? L extends SingularPlural
          ? false
          : L extends `${string}s`
            ? Singular<L> extends Measure
              ? false
              : Rest extends ["count"]
                ? false
                : true
            : false
        : false
  : false;
type Measure = "view" | "like" | "vote" | "dislike" | "click" | "download" | "impression" | "visit" | "reaction" | "page" | "word" | "character";

type ListRuleOf<Name extends string, T extends string[], F extends FieldNode> = F["pg"] extends true
  ? true
  : PluralLast<Last<T>> extends true
    ? true
    : Lowercase<Name> extends "list"
      ? true
      : Last<T> extends "list"
        ? true
        : T extends ["all", string, ...string[]]
          ? true
          : F["ids"] extends true
            ? true
            : F["ll"];

type ImageWord = "avatar" | "image" | "photo" | "thumbnail" | "picture" | "logo";
type ImageSuffix = "url" | "uri" | "link" | "src";
type UrlWord = "url" | "uri" | "link" | "website" | "homepage";
type PhoneWord = "phone" | "mobile" | "tel" | "telephone";
type BoolPrefix = "is" | "has" | "can" | "should" | "was" | "did" | "allow" | "allows" | "allowed";
type BoolSuffix = "enabled" | "active" | "verified" | "public" | "deleted" | "archived" | "flag";
type IntLast = "count" | "total" | "qty" | "quantity" | "num" | "age" | "year" | "index" | "position" | "rank" | "level" | "size" | "length" | "views" | "likes" | "votes";
type FloatLast = "price" | "cost" | "amount" | "total" | "subtotal" | "tax" | "fee" | "balance" | "salary" | "revenue" | "rate" | "ratio" | "score" | "rating" | "weight" | "height" | "lat" | "lng" | "latitude" | "longitude" | "percent";

type Has<T extends string[], W extends string> = W extends T[number] ? true : false;
type AnyImage<T extends string[]> = [Extract<T[number], ImageWord>] extends [never] ? false : true;

/** T1 to T13 reduced to the JSON type: `string`, `number` or `boolean` (dates and IDs are strings). */
type ScalarJs<T extends string[]> = T extends []
  ? string
  : Last<T> extends "id"
    ? string
    : Last<T> extends "email" | "mail"
      ? string
      : Last<T> extends "address"
        ? Has<T, "email"> extends true
          ? string
          : Next<T>
        : Last<T> extends ImageWord
          ? string
          : Last<T> extends ImageSuffix
            ? AnyImage<T> extends true
              ? string
              : Next<T>
            : Next<T>;
type Next<T extends string[]> = Last<T> extends UrlWord
  ? string
  : Has<T, "url"> extends true
    ? string
    : Last<T> extends PhoneWord
      ? string
      : T[0] extends BoolPrefix
        ? boolean
        : Last<T> extends BoolSuffix
          ? boolean
          : T extends ["number", "of", ...string[]]
            ? number
            : Last<T> extends IntLast | FloatLast
              ? number
              : string;
/** `deletedAt` is null by default (rule T10). */
type DeletedAt<T extends string[]> = T extends ["deleted", "at"] ? true : false;

// ---- the AST ------------------------------------------------------------------------------------

type Item = FieldNode | { k: "i"; on: string | null; sel: Item[] } | { k: "s"; n: string };
interface FieldNode {
  k: "f";
  n: string;
  a: string;
  /** a paging argument, an `ids` argument, a list-valued argument */
  pg: boolean;
  ids: boolean;
  ll: boolean;
  ls: "list" | "one" | null;
  ty: string | null;
  nr: boolean;
  /** @gen, @pattern or @pick: the generator name and, for @pick, the value tokens */
  gn: null | { g: string; v: string[] | null };
  dv: string | null;
  /** @skip or @include: the key may be absent */
  op: boolean;
  sel: Item[] | null;
}
interface ArgInfo {
  n: string;
  v: Record<string, unknown>;
  l: boolean;
}

type Pop<D extends 0[]> = D extends [0, ...infer R extends 0[]] ? R : [];
type IsListVar<V extends string, VL extends string, Dflt extends boolean> = V extends `$${infer N}` ? (N extends VL ? true : Dflt) : Dflt;

/** Read a list literal `[a, b]` (the opening bracket is consumed); nested values become "{". */
type ReadList<S extends string, Acc extends string[] = [], D extends 0[] = []> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? D extends []
    ? H extends "]"
      ? [Acc, R]
      : H extends "[" | "{"
        ? ReadList<R, [...Acc, "{"], [0]>
        : ReadList<R, [...Acc, H], D>
    : H extends "[" | "{"
      ? ReadList<R, Acc, [...D, 0]>
      : H extends "]" | "}"
        ? ReadList<R, Acc, Pop<D>>
        : ReadList<R, Acc, D>
  : [Acc, ""];

/** Read the arguments of a field or directive (the opening parenthesis is consumed). */
type ReadArgs<S extends string, D extends 0[], Acc extends ArgInfo, VL extends string> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends ")"
    ? D extends [0]
      ? [Acc, R]
      : ReadArgs<R, Pop<D>, Acc, VL>
    : H extends "(" | "{" | "["
      ? ReadArgs<R, [...D, 0], Acc, VL>
      : H extends "}" | "]"
        ? ReadArgs<R, Pop<D>, Acc, VL>
        : D extends [0]
          ? Tok1<R> extends [":", infer R1 extends string]
            ? Tok1<R1> extends [infer V extends string, infer R2 extends string]
              ? V extends "["
                ? ReadList<R2> extends [infer Items extends string[], infer R3 extends string]
                  ? ReadArgs<R3, D, { n: Acc["n"] | H; v: Acc["v"] & { [K in H]: Items }; l: true }, VL>
                  : Acc
                : V extends "{"
                  ? ReadArgs<R1, D, { n: Acc["n"] | H; v: Acc["v"] & { [K in H]: "{" }; l: Acc["l"] }, VL>
                  : ReadArgs<R2, D, { n: Acc["n"] | H; v: Acc["v"] & { [K in H]: V }; l: IsListVar<V, VL, Acc["l"]> }, VL>
              : Acc
            : ReadArgs<R, D, Acc, VL>
          : ReadArgs<R, D, Acc, VL>
  : [Acc, ""];

type NoArgs = { n: never; v: {}; l: false };
/** Directives after a field: `@name` and `@name(args)`. */
type ReadDirs<S extends string, VL extends string, Acc = {}> = Tok1<S> extends ["@", infer R extends string]
  ? Tok1<R> extends [infer N extends string, infer R2 extends string]
    ? Tok1<R2> extends ["(", infer R3 extends string]
      ? ReadArgs<R3, [0], NoArgs, VL> extends [infer A extends ArgInfo, infer R4 extends string]
        ? ReadDirs<R4, VL, Acc & { [K in N]: A["v"] }>
        : [Acc, ""]
      : ReadDirs<R2, VL, Acc & { [K in N]: {} }>
    : [Acc, ""]
  : [Acc, S];

type Unquote<S> = S extends `"${infer B}` ? B : never;
type DirType<D> = D extends { type: { name: infer V } } ? (V extends string ? (Unquote<V> extends infer U extends string ? ([U] extends [never] ? null : U) : null) : null) : null;
type DirGen<D> = D extends { gen: { name: infer V } }
  ? [Unquote<V>] extends [never]
    ? { g: ""; v: null }
    : { g: Unquote<V>; v: null }
  : D extends { pattern: unknown }
    ? { g: "pattern"; v: null }
    : D extends { pick: { values: infer V extends string[] } }
      ? { g: "oneOf"; v: V }
      : D extends { pick: unknown }
        ? { g: "oneOf"; v: ["{"] }
        : null;
type DirNull<D> = D extends { nullRate: { p: infer V } } ? (V extends "0" | "0.0" | "0.00" ? false : true) : false;
type DirDerive<D> = D extends { derive: { from: infer V } } ? (V extends string ? (Unquote<V> extends infer U extends string ? ([U] extends [never] ? null : U) : null) : null) : null;
type DirList<D> = D extends { list: unknown } ? "list" : D extends { one: unknown } ? "one" : null;
type DirOpt<D> = D extends { skip: unknown } | { include: unknown } ? true : false;

type MakeField<Alias extends string, Name extends string, A extends ArgInfo, D, Sel extends Item[] | null> = {
  k: "f";
  n: Name;
  a: Alias;
  pg: [A["n"] & PagingArg] extends [never] ? false : true;
  ids: "ids" extends A["n"] ? true : false;
  ll: A["l"];
  ls: DirList<D>;
  ty: DirType<D>;
  nr: DirNull<D>;
  gn: DirGen<D>;
  dv: DirDerive<D>;
  op: DirOpt<D>;
  sel: Sel;
};

// ---- parser: selection sets (recursive descent over the text) ---------------------------------------
// One selection set is a loop (the compiler allows 1000 tail steps); nested sets nest the evaluation.

/** A selection set of more than 600 items is not parsed (the result falls back to `Record<string, unknown>`). */
type ParseSel<S extends string, Cur extends Item[], VL extends string> = Cur["length"] extends 600
  ? { bad: true }
  : Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends "}"
    ? { sel: Cur; rest: R }
    : (H extends "..." ? ParseSpread<R, VL> : ParseField<H, R, VL>) extends [infer It extends Item, infer R2 extends string]
      ? ParseSel<R2, [...Cur, It], VL>
      : { bad: true }
  : { bad: true };

type SkipDirs<S extends string, VL extends string> = ReadDirs<S, VL> extends [unknown, infer R extends string] ? R : S;

/** A nested selection set (the opening brace is consumed): `[sel, rest]`. */
type Nested<S extends string, VL extends string> = ParseSel<S, [], VL> extends { sel: infer Sel extends Item[]; rest: infer R extends string } ? [Sel, R] : { bad: true };

type ParseSpread<S extends string, VL extends string> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends "on"
    ? Tok1<R> extends [infer C extends string, infer R1 extends string]
      ? Tok1<SkipDirs<R1, VL>> extends ["{", infer R2 extends string]
        ? Nested<R2, VL> extends [infer Sel extends Item[], infer R3 extends string]
          ? [{ k: "i"; on: C; sel: Sel }, R3]
          : { bad: true }
        : { bad: true }
      : { bad: true }
    : H extends "{"
      ? Nested<R, VL> extends [infer Sel extends Item[], infer R3 extends string]
        ? [{ k: "i"; on: null; sel: Sel }, R3]
        : { bad: true }
      : H extends "@"
        ? Tok1<SkipDirs<S, VL>> extends ["{", infer R2 extends string]
          ? Nested<R2, VL> extends [infer Sel extends Item[], infer R3 extends string]
            ? [{ k: "i"; on: null; sel: Sel }, R3]
            : { bad: true }
          : { bad: true }
        : [{ k: "s"; n: H }, SkipDirs<R, VL>]
  : { bad: true };

type ParseField<H extends string, R extends string, VL extends string> = Tok1<R> extends [":", infer R1 extends string]
  ? Tok1<R1> extends [infer Real extends string, infer R2 extends string]
    ? ParseField2<H, Real, R2, VL>
    : { bad: true }
  : ParseField2<H, H, R, VL>;

type ParseField2<Alias extends string, Name extends string, R extends string, VL extends string> = Tok1<R> extends ["(", infer R1 extends string]
  ? ReadArgs<R1, [0], NoArgs, VL> extends [infer A extends ArgInfo, infer R2 extends string]
    ? ParseField3<Alias, Name, A, R2, VL>
    : { bad: true }
  : ParseField3<Alias, Name, NoArgs, R, VL>;

type ParseField3<Alias extends string, Name extends string, A extends ArgInfo, R extends string, VL extends string> = ReadDirs<R, VL> extends [infer D, infer R2 extends string]
  ? Tok1<R2> extends ["{", infer R3 extends string]
    ? Nested<R3, VL> extends [infer Sel extends Item[], infer R4 extends string]
      ? [MakeField<Alias, Name, A, D, Sel>, R4]
      : { bad: true }
    : [MakeField<Alias, Name, A, D, null>, R2]
  : { bad: true };

/** Operation header: name, variable definitions (collect the list-typed variables), directives. */
type VarDefs<S extends string, D extends 0[], VL extends string> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends ")"
    ? D extends [0]
      ? [VL, R]
      : VarDefs<R, Pop<D>, VL>
    : H extends "(" | "{" | "["
      ? VarDefs<R, [...D, 0], VL>
      : H extends "}" | "]"
        ? VarDefs<R, Pop<D>, VL>
        : H extends `$${infer N}`
          ? Tok1<R> extends [":", infer R1 extends string]
            ? Tok1<R1> extends ["[", infer R2 extends string]
              ? VarDefs<R2, [...D, 0], VL | N>
              : VarDefs<R1, D, VL>
            : VarDefs<R, D, VL>
          : VarDefs<R, D, VL>
  : [VL, ""];
type OpHead<S extends string, VL extends string = never> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends "{"
    ? [VL, R]
    : H extends "("
      ? VarDefs<R, [0], VL> extends [infer V extends string, infer R2 extends string]
        ? OpHead<R2, V>
        : never
      : OpHead<R, VL>
  : never;

interface DocT {
  ops: Item[][];
  frags: Record<string, { on: string; sel: Item[] }>;
  ok: boolean;
}
type Failed<Ops extends Item[][], Frags> = { ops: Ops; frags: Frags; ok: false };
type Doc<S extends string, Ops extends Item[][] = [], Frags extends DocT["frags"] = {}> = Tok1<S> extends [infer H extends string, infer R extends string]
  ? H extends "{"
    ? ParseSel<R, [], never> extends { sel: infer Sel extends Item[]; rest: infer R2 extends string }
      ? Doc<R2, [...Ops, Sel], Frags>
      : Failed<Ops, Frags>
    : H extends "query" | "mutation" | "subscription"
      ? OpHead<R> extends [infer VL extends string, infer R2 extends string]
        ? ParseSel<R2, [], VL> extends { sel: infer Sel extends Item[]; rest: infer R3 extends string }
          ? Doc<R3, [...Ops, Sel], Frags>
          : Failed<Ops, Frags>
        : Failed<Ops, Frags>
      : H extends "fragment"
        ? Tok1<R> extends [infer N extends string, infer R1 extends string]
          ? Tok1<R1> extends ["on", infer R2 extends string]
            ? Tok1<R2> extends [infer C extends string, infer R3 extends string]
              ? Tok1<SkipDirs<R3, never>> extends ["{", infer R4 extends string]
                ? ParseSel<R4, [], never> extends { sel: infer Sel extends Item[]; rest: infer R5 extends string }
                  ? Doc<R5, Ops, Frags & { [K in N]: { on: C; sel: Sel } }>
                  : Failed<Ops, Frags>
                : Failed<Ops, Frags>
              : Failed<Ops, Frags>
            : Failed<Ops, Frags>
          : Failed<Ops, Frags>
        : Failed<Ops, Frags>
  : { ops: Ops; frags: Frags; ok: true };

// ---- evaluation ---------------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Fields of a selection set, looking through every fragment (the `flattenFields` of src/infer.js). */
type Flatten<Sel extends Item[], Fr, Acc extends FieldNode[] = []> = Sel extends [infer I, ...infer R extends Item[]]
  ? I extends FieldNode
    ? Flatten<R, Fr, [...Acc, I]>
    : I extends { k: "i"; sel: infer S extends Item[] }
      ? Flatten<R, Fr, [...Acc, ...Flatten<S, Fr>]>
      : I extends { k: "s"; n: infer N }
        ? N extends keyof Fr
          ? Fr[N] extends { sel: infer S extends Item[] }
            ? Flatten<R, Fr, [...Acc, ...Flatten<S, Fr>]>
            : Flatten<R, Fr, Acc>
          : Flatten<R, Fr, Acc>
        : Flatten<R, Fr, Acc>
  : Acc;

/** The fields of one possible type of a union or interface (`walkAbstract` in src/infer.js). */
type FlattenFor<Sel extends Item[], Fr, T extends string, Acc extends FieldNode[] = []> = Sel extends [infer I, ...infer R extends Item[]]
  ? I extends FieldNode
    ? FlattenFor<R, Fr, T, [...Acc, I]>
    : I extends { k: "i"; on: infer C; sel: infer S extends Item[] }
      ? C extends null
        ? FlattenFor<R, Fr, T, [...Acc, ...FlattenFor<S, Fr, T>]>
        : C extends T
          ? FlattenFor<R, Fr, T, [...Acc, ...Flatten<S, Fr>]>
          : FlattenFor<R, Fr, T, Acc>
      : I extends { k: "s"; n: infer N }
        ? N extends keyof Fr
          ? Fr[N] extends { on: infer C; sel: infer S extends Item[] }
            ? C extends T
              ? FlattenFor<R, Fr, T, [...Acc, ...Flatten<S, Fr>]>
              : FlattenFor<R, Fr, T, Acc>
            : FlattenFor<R, Fr, T, Acc>
          : FlattenFor<R, Fr, T, Acc>
        : FlattenFor<R, Fr, T, Acc>
  : Acc;

/** Distinct type conditions applied directly to a field's selection (rules N2 and S4). */
type Explicit<Sel extends Item[], Fr, Acc extends string = never> = Sel extends [infer I, ...infer R extends Item[]]
  ? I extends { k: "i"; on: infer C; sel: infer S extends Item[] }
    ? C extends string
      ? Explicit<R, Fr, Acc | C>
      : Explicit<R, Fr, Acc | Explicit<S, Fr>>
    : I extends { k: "s"; n: infer N }
      ? N extends keyof Fr
        ? Fr[N] extends { on: infer C extends string }
          ? Explicit<R, Fr, Acc | C>
          : Explicit<R, Fr, Acc>
        : Explicit<R, Fr, Acc>
      : Explicit<R, Fr, Acc>
  : Acc;

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends unknown ? ([U] extends [T] ? false : true) : never;

/** Merge fields with the same response key: their selections concatenate. */
type Dedupe<Fl extends FieldNode[]> = { [A in Fl[number]["a"]]: ByAlias<Fl, A> };
type ByAlias<Fl extends FieldNode[], A extends string> = Extract<Fl[number], { a: A }> extends infer X ? (IsUnion<X> extends true ? FoldAlias<Fl, A> : X) : never;
type FoldAlias<Fl extends FieldNode[], A extends string, Acc = never> = Fl extends [infer F extends FieldNode, ...infer R extends FieldNode[]]
  ? F["a"] extends A
    ? FoldAlias<R, A, [Acc] extends [never] ? F : MergeField<Acc, F>>
    : FoldAlias<R, A, Acc>
  : Acc;
type MergeField<A, B extends FieldNode> = A extends FieldNode ? (A["sel"] extends Item[] ? (B["sel"] extends Item[] ? { [K in keyof A]: K extends "sel" ? [...A["sel"], ...B["sel"]] : A[K] } : A) : A) : A;

type ReqKeys<D> = { [K in keyof D]: D[K] extends { op: true } ? never : K }[keyof D];
type OptKeys<D> = { [K in keyof D]: D[K] extends { op: true } ? K : never }[keyof D];

type Syn = "conn" | "edge" | "page" | null;

type ObjOf<Fl extends FieldNode[], Fr, TN extends string, S extends Syn = null, Itm extends string = ""> = Dedupe<Fl> extends infer D
  ? Simplify<{ [K in ReqKeys<D> & string]: ValOf<D[K & keyof D], Fr, TN, S, Itm> } & { [K in OptKeys<D> & string]?: ValOf<D[K & keyof D], Fr, TN, S, Itm> }>
  : never;

type ValOf<N, Fr, TN extends string, S extends Syn, Itm extends string> = N extends FieldNode ? Val<N, Fr, TN, S, Itm> : never;

type Val<F extends FieldNode, Fr, TN extends string, S extends Syn, Itm extends string> = S extends "conn"
  ? F["n"] extends "edges"
    ? F["sel"] extends Item[]
      ? ObjOf<Flatten<F["sel"], Fr>, Fr, `${Itm}Edge`, "edge", Itm>[]
      : unknown
    : F["n"] extends "nodes"
      ? F["sel"] extends Item[]
        ? ObjOf<Flatten<F["sel"], Fr>, Fr, Itm>[]
        : unknown
      : F["n"] extends "pageInfo"
        ? F["sel"] extends Item[]
          ? ObjOf<Flatten<F["sel"], Fr>, Fr, "PageInfo", "page">
          : unknown
        : F["n"] extends "totalCount"
          ? number
          : Plain<F, Fr, TN>
  : S extends "edge"
    ? F["n"] extends "cursor"
      ? string
      : F["n"] extends "node"
        ? F["sel"] extends Item[]
          ? ObjOf<Flatten<F["sel"], Fr>, Fr, Itm>
          : unknown
        : Plain<F, Fr, TN>
    : S extends "page"
      ? F["n"] extends "hasNextPage" | "hasPreviousPage"
        ? boolean
        : F["n"] extends "startCursor" | "endCursor"
          ? string | null
          : Plain<F, Fr, TN>
      : Plain<F, Fr, TN>;

type Plain<F extends FieldNode, Fr, TN extends string> = F["sel"] extends infer S extends Item[] ? ObjectValue<F, S, Fr> : ScalarValue<F, TN>;

type Nullable<F extends FieldNode, T> = F["nr"] extends true ? T | null : T;

// scalars ----

type GenJs<G extends { g: string; v: string[] | null }, Dflt> = G["g"] extends "oneOf"
  ? G["v"] extends string[]
    ? PickJs<G["v"]>
    : unknown
  : G["g"] extends "pattern"
    ? string
    : G["g"] extends keyof GeneratorTypes
      ? GeneratorTypes[G["g"]]
      : G["g"] extends ""
        ? Dflt
        : unknown;
/** `@pick(values: [...])`: literal strings stay literal; numbers and booleans widen; anything else is unknown. */
type PickJs<V extends string[]> = "{" extends V[number]
  ? unknown
  : V extends []
    ? never
    : PickOne<V[number]>;
type PickOne<T extends string> = T extends `"${infer S}` ? S : T extends "true" | "false" ? boolean : T extends `${Digit}${string}` | `-${string}` ? number : unknown;

type ScalarList<F extends FieldNode, T extends string[]> = F["ls"] extends "list" ? true : F["ls"] extends "one" ? false : F["dv"] extends string ? false : CountOf<T> extends true ? false : ListRuleOf<F["n"], T, F>;

type ScalarValue<F extends FieldNode, TN extends string> = F["n"] extends "__typename"
  ? TN
  : Words<F["n"]> extends infer T extends string[]
    ? ScalarList<F, T> extends infer L
      ? Nullable<F, ScalarBase<F, T, L>> extends infer V
        ? L extends true
          ? F["nr"] extends true
            ? Exclude<V, null>[] | null
            : V[]
          : V
        : never
      : never
    : never;
type ScalarBase<F extends FieldNode, T extends string[], L> = F["gn"] extends { g: string; v: string[] | null }
  ? GenJs<F["gn"], ScalarJs<L extends true ? SingularLast<T> : T>>
  : F["dv"] extends string
    ? ScalarJs<Words<F["dv"]>>
    : CountOf<T> extends true
      ? number
      : L extends true
        ? ScalarJs<SingularLast<T>>
        : DeletedAt<T> extends true
          ? string | null
          : ScalarJs<T>;

// objects ----

type TypeNameFor<F extends FieldNode, Ex extends string> = F["ty"] extends string ? F["ty"] : [Ex] extends [never] ? TypeNameOf<F["n"]> : IsUnion<Ex> extends true ? TypeNameOf<F["n"]> : Ex;

type NamesWithSel<Kids extends FieldNode[]> = Kids[number] extends infer K ? (K extends { n: infer N; sel: Item[] } ? N : never) : never;
type AllNames<Kids extends FieldNode[]> = Kids[number]["n"];

type IsConnection<Kids extends FieldNode[], Ex extends string, F extends FieldNode> = F["ty"] extends string
  ? false
  : [Ex] extends [never]
    ? ConnShape<Kids>
    : Ex extends `${string}Connection`
      ? IsUnion<Ex> extends true
        ? ConnShape<Kids>
        : true
      : ConnShape<Kids>;
type ConnShape<Kids extends FieldNode[]> = "edges" extends NamesWithSel<Kids>
  ? true
  : "pageInfo" extends NamesWithSel<Kids>
    ? true
    : "nodes" extends NamesWithSel<Kids>
      ? "totalCount" extends AllNames<Kids>
        ? true
        : false
      : false;

type ConnItem<F extends FieldNode, Ex extends string> = [Ex] extends [never]
  ? ConnItemByName<F>
  : IsUnion<Ex> extends true
    ? ConnItemByName<F>
    : Ex extends `${infer I}Connection`
      ? I extends ""
        ? "Node"
        : I
      : ConnItemByName<F>;
type ConnItemByName<F extends FieldNode> = Words<F["n"]> extends infer T extends string[]
  ? Last<T> extends "connection"
    ? TypeNameOf<Init<T> extends [] ? F["n"] : Join<Init<T>>>
    : TypeNameOf<F["n"]>
  : never;
type Join<T extends string[], Acc extends string = ""> = T extends [infer H extends string, ...infer R extends string[]] ? Join<R, Acc extends "" ? H : `${Acc}_${H}`> : Acc;

type ObjectValue<F extends FieldNode, Sel extends Item[], Fr> = Explicit<Sel, Fr> extends infer E0 extends string
  ? (F["ty"] extends string ? F["ty"] : E0) extends infer Ex extends string
    ? Flatten<Sel, Fr> extends infer Kids extends FieldNode[]
      ? IsUnion<Ex> extends true
        ? ListWrap<F, ObjList<F>, UnionObj<Sel, Fr, Ex>>
        : IsConnection<Kids, Ex, F> extends true
          ? ListWrap<F, false, ObjOf<Kids, Fr, ConnTN<F, Ex>, "conn", ConnItem<F, Ex>>>
          : ListWrap<F, ObjList<F>, ObjOf<Kids, Fr, TypeNameFor<F, Ex>>>
      : never
    : never
  : never;
type ConnTN<F extends FieldNode, Ex extends string> = `${ConnItem<F, Ex>}Connection`;
type UnionObj<Sel extends Item[], Fr, Ex extends string> = Ex extends string ? ObjOf<FlattenFor<Sel, Fr, Ex>, Fr, Ex> : never;

/** Object fields: the list rule without argument-literal lists for unions (src/infer.js finalize). */
type ObjList<F extends FieldNode> = F["ls"] extends "list" ? true : F["ls"] extends "one" ? false : Words<F["n"]> extends infer T extends string[] ? ListRuleOf<F["n"], T, F> : false;
type ListWrap<F extends FieldNode, L, V> = L extends true ? Nullable<F, V[]> : Nullable<F, V>;

// ---- public --------------------------------------------------------------------------------------

type AnyData = Record<string, unknown>;
type Eval<D> = D extends { ok: true; ops: [infer S extends Item[]]; frags: infer Fr }
  ? ObjOf<Flatten<S, Fr>, Fr, "Query">
  : AnyData;
type ParseAll<Q extends string> = Doc<Q>;

/**
 * The data a query returns, inferred from the query text. A query that is not a literal type
 * (a `string` variable), has several operations or cannot be parsed gives `Record<string, unknown>`.
 */
export type ResultOf<Q> = Q extends string ? (string extends Q ? AnyData : Eval<ParseAll<Q>>) : AnyData;

type ItemOfValue<V> = NonNullable<V> extends infer N
  ? N extends readonly (infer E)[]
    ? E
    : N extends { nodes: readonly (infer E)[] }
      ? E
      : N extends { edges: readonly { node: infer E }[] }
        ? E
        : unknown
  : never;

type RootFields<Q extends string> = Doc<Q> extends { ok: true; ops: [infer S extends Item[]]; frags: infer Fr } ? [Flatten<S, Fr>, Fr] : never;
type FirstCollection<Fl extends FieldNode[], Fr> = Fl extends [infer F extends FieldNode, ...infer R extends FieldNode[]]
  ? F["sel"] extends Item[]
    ? Val<F, Fr, "Query", null, ""> extends infer V
      ? NonNullable<V> extends readonly unknown[] | { edges: unknown } | { nodes: unknown }
        ? F
        : FirstCollection<R, Fr>
      : never
    : FirstCollection<R, Fr>
  : never;

/**
 * The type of one item of the root collection `stream()` yields: the elements of the first root list,
 * the nodes of a root connection, or the root field named by `Field` (a response key).
 */
export type ItemOf<Q, Field extends string | undefined = undefined> = Q extends string
  ? string extends Q
    ? Record<string, any>
    : RootFields<Q> extends [infer Fl extends FieldNode[], infer Fr]
      ? (Field extends string ? Extract<Fl[number], { a: Field }> : FirstCollection<Fl, Fr>) extends infer F
        ? [F] extends [never]
          ? Record<string, any>
          : F extends FieldNode
            ? ItemOfValue<Val<F, Fr, "Query", null, "">>
            : never
        : never
      : Record<string, any>
  : Record<string, any>;
