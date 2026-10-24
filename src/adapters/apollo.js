// Apollo Client link backed by a graceholder world. `@apollo/client` is an optional peer
// dependency and is imported only here.
import { ApolloLink, Observable } from "@apollo/client";
import { resolveWorld, seedOf, latencyFor } from "./shared.js";

/**
 * A terminating link: it answers every operation from a world and never forwards.
 * Place it last in the link chain, in place of `HttpLink`.
 */
export class GraceholderLink extends ApolloLink {
  /** @param {import("./apollo.js").GraceholderLinkOptions} [options] */
  constructor(options = {}) {
    super();
    this.world = resolveWorld(options);
    this._seed = seedOf(this.world);
    this._latency = options.latency;
    this._delay = options.delay;
  }

  request(operation) {
    const { query, variables, operationName } = operation;
    const ms = latencyFor(this._latency, this._seed, { query, operationName, variables });
    return new Observable((observer) => {
      let closed = false;
      let timer;
      const answer = () => {
        if (closed) return;
        // the document goes to the world as is: it accepts a DocumentNode
        const result = this.world.query(query, { variables, operationName });
        observer.next(result);
        observer.complete();
      };
      if (this._delay) {
        Promise.resolve(this._delay(ms)).then(answer);
      } else if (ms > 0) {
        timer = setTimeout(answer, ms);
      } else {
        answer();
      }
      return () => {
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    });
  }
}

export { GraceholderLink as default };
