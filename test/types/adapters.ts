import { createWorld } from "@johnhenry/graceholder";
import { GraceholderLink } from "@johnhenry/graceholder/apollo";
import { graceholderExchange } from "@johnhenry/graceholder/urql";
import { createFetch, type GraceholderFetch } from "@johnhenry/graceholder/fetch";
import { ApolloLink } from "@apollo/client";
import type { Exchange } from "@urql/core";

const world = createWorld({ seed: "t" });
const link: ApolloLink = new GraceholderLink({ world, latency: [10, 50] });
const link2 = new GraceholderLink({ seed: 1, spec: { users: { count: 2 } }, latency: { min: 1, max: 2 }, delay: (ms: number) => void ms });
const exchange: Exchange = graceholderExchange({ seed: "t", latency: 20 });
const f: GraceholderFetch = createFetch({ world, match: /\/gql$/, fallback: fetch, latency: false });
const g = createFetch({ seed: "x", match: (url, { method }) => url.pathname === "/g" && method === "POST" });
const w: typeof world = link2.world;
void [link, exchange, f, g, w];
