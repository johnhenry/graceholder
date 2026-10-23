// urql exchange backed by a graceholder world. `@urql/core` and `wonka` are optional peer
// dependencies and are imported only here.
import { makeResult } from "@urql/core";
import { pipe, share, filter, mergeMap, merge, fromPromise, takeUntil } from "wonka";
import { resolveWorld, seedOf, latencyFor, wait } from "./shared.js";

const answers = (op) => op.kind === "query" || op.kind === "mutation";

function operationNameOf(operation) {
  const def = operation.query.definitions.find((d) => d.kind === "OperationDefinition");
  return def?.name?.value;
}

/**
 * An exchange that answers query and mutation operations from a world.
 *
 * It terminates those operations, so it takes the place of `fetchExchange`: put it last, after
 * `cacheExchange` (and after `mapExchange`, `authExchange` and the like, which do not apply to
 * a backend that is not there). Subscriptions are passed to `forward`, so an exchange for
 * them may follow it. Keeping `fetchExchange` after it is harmless: it never sees a query or a
 * mutation.
 */
export function graceholderExchange(options = {}) {
  const world = resolveWorld(options);
  const seed = seedOf(world);

  return ({ forward }) =>
    (ops$) => {
      const shared$ = share(ops$);
      const handled$ = pipe(
        shared$,
        filter(answers),
        mergeMap((operation) => {
          const variables = operation.variables ?? undefined;
          const operationName = operationNameOf(operation);
          const ms = latencyFor(options.latency, seed, { query: operation.query, operationName, variables });
          // a teardown with the same key cancels the answer that is still waiting
          const teardown$ = pipe(
            shared$,
            filter((o) => o.kind === "teardown" && o.key === operation.key),
          );
          const result$ = fromPromise(
            wait(ms, options.delay).then(() => makeResult(operation, world.query(operation.query, { variables, operationName }))),
          );
          return pipe(result$, takeUntil(teardown$));
        }),
      );
      const forwarded$ = forward(pipe(shared$, filter((op) => !answers(op))));
      return merge([handled$, forwarded$]);
    };
}

export { graceholderExchange as default };
