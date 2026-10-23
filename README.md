# graceholder

Consistently repeatable generated data, in any shape you want, from a GraphQL query.

> Status: under construction (pre-1.0, not yet published). The design is in
> [docs/design.md](docs/design.md); work is tracked in the repository issues.

```js
import { graceholder } from "@johnhenry/graceholder";

graceholder(`{ users { id name email } }`, { seed: "demo" });
```

The same seed, query and options always produce byte-identical output: every
value is a pure function of a key, not of a shared random stream, so reordering
fields, adding siblings or changing aliases never changes another value.

Library only (no CLI, no server). ESM, Node >= 22 and browsers, with
`graphql` as the only runtime dependency.

## Development

```sh
npm ci
npm run check   # banned-token lint, typecheck, tests
```

MIT licensed.
