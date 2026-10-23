# Stability policy

This file is generated from section 11 of [docs/design.md](docs/design.md) by `npm run stability`. Do not edit it by hand.

The key-scheme version literal is exported as `KEY_SCHEME` (currently `"gh1"`).

**Guarantee:** same `seed` + same query + same `spec` + same options + same package version => byte-identical output (`JSON.stringify` equality), on every supported runtime (Node >= 22, evergreen browsers). Across versions: within a major version, output for a given input never changes.

**What counts as an output change (needs a major bump):**
- the key scheme (`gh1` literal, separator, component set or order), hash, RNG, helper formulas (`int`, `pick`, etc.);
- any generator's value for the same draws; generator catalogue *semantics* changes;
- any vocabulary table edit, reorder or locale default change;
- inference rules: shape, type-name, count, scalar-type or generator selection for a previously inferred case; the singularizer; persona table; derivation formulas; paging and cursor formats; `anchorDate` default;
- changes to how directives/spec properties resolve (precedence).

**Not output changes (minor/patch):** new generators, new directives or spec properties, new locales, error-message wording, performance, types, docs and the `suggestSpec` prompt. (newly recognised name heuristics are output changes, even for names that currently fall through to `T13`). Only strictly additive features that cannot affect existing inputs qualify.

**Enforcement:**
- Golden files: `test/golden/*.json` (input query + spec + options + expected output). CI runs them on Node 22 and the current LTS, and in a browser-like runner (Node with `--experimental-vm-modules` jsdom-free check is enough; plus a Playwright smoke in M5). A PR that changes a golden file requires the `breaking` label and a changeset marked major; a CI script fails otherwise.
- The XXH64/SplitMix64 vectors and vocabulary SHA-256 checksums are asserted separately.
- Dependency policy: the only runtime dependency is `graphql` (peer range `^16`, tested on 16 and 17-alpha if available). graphql-js affects execution semantics, not values, and the golden tests would catch any change. Everything affecting values (hash, RNG, vocab) is in-repo. `devDependencies` are free to float.
- A `STABILITY.md` generated from this section ships with the package; the key-scheme version literal `gh1` is exported as `KEY_SCHEME`.
