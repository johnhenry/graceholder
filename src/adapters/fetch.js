// A fetch-compatible function that answers GraphQL requests from a graceholder world. It uses
// only web-standard globals (Request, Response, URL, Headers), no optional dependency.
import { parse } from "graphql";
import { resolveWorld, seedOf, latencyFor, wait } from "./shared.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const respond = (status, body, extra) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
const badRequest = (message, status = 400, code = "bad-request") => respond(status, { errors: [{ message, extensions: { code } }] });

// relative URLs resolve against the page when it has an http(s) origin (not about:blank, not a file)
const base = () => (typeof location !== "undefined" && /^https?:/.test(location.href) ? location.href : "http://localhost/");

function toUrl(input) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, base());
  } catch {
    return null;
  }
}

function makeMatcher(match) {
  if (match === undefined) return (url) => url.pathname.replace(/\/+$/, "").endsWith("/graphql");
  if (typeof match === "string") return (url) => url.pathname === match || url.href === match;
  if (match instanceof RegExp) return (url) => match.test(url.href);
  if (typeof match === "function") return match;
  throw new TypeError("match must be a string, a RegExp or a function (url, { method }) => boolean");
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalise one GraphQL-over-HTTP request object. @returns {{ error: Response } | { query: string, variables?: object, operationName?: string }} */
function readOperation(raw) {
  if (!isObject(raw)) return { error: badRequest("A GraphQL request must be a JSON object.") };
  if (typeof raw.query !== "string" || raw.query === "") return { error: badRequest("Must provide a query string.") };
  let variables = raw.variables;
  if (typeof variables === "string") {
    try {
      variables = JSON.parse(variables);
    } catch {
      return { error: badRequest("Variables are invalid JSON.") };
    }
  }
  if (variables !== undefined && variables !== null && !isObject(variables)) return { error: badRequest("Variables must be a JSON object.") };
  const operationName = raw.operationName ?? undefined;
  if (operationName !== undefined && typeof operationName !== "string") return { error: badRequest("operationName must be a string.") };
  return { query: raw.query, variables: variables ?? undefined, operationName };
}

/** The kind of the operation that would run, or undefined when the document does not parse. */
function operationKind({ query, operationName }) {
  try {
    const ops = parse(query).definitions.filter((d) => d.kind === "OperationDefinition");
    const op = operationName ? ops.find((d) => d.name?.value === operationName) : ops.length === 1 ? ops[0] : undefined;
    return op?.operation;
  } catch {
    return undefined;
  }
}

const abortError = (signal) => signal.reason ?? new DOMException("This operation was aborted", "AbortError");

/** Wait for `ms`, rejecting if `signal` aborts first. */
function waitOrAbort(ms, delay, signal) {
  if (!signal) return wait(ms, delay);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    wait(ms, delay).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      reject,
    );
  });
}

/**
 * @param {import("./fetch.js").CreateFetchOptions} [options]
 * @returns {typeof fetch & { world: import("../index.js").World }}
 */
export function createFetch(options = {}) {
  const world = resolveWorld(options);
  const seed = seedOf(world);
  const matches = makeMatcher(options.match);

  const fetchLike = async function graceholderFetch(input, init) {
    const url = toUrl(input);
    const method = (init?.method ?? (typeof input === "object" && input && "method" in input ? input.method : "GET")).toUpperCase();
    if (!url || !matches(url, { method })) {
      const next = options.fallback ?? globalThis.fetch;
      if (typeof next !== "function") throw new TypeError("graceholder fetch: no fallback and no globalThis.fetch");
      return next(input, init);
    }
    const signal = init?.signal ?? (typeof input === "object" && input && "signal" in input ? input.signal : undefined);

    let payload;
    let isMutationAllowed = true;
    if (method === "GET" || method === "HEAD") {
      isMutationAllowed = false;
      const p = url.searchParams;
      payload = { query: p.get("query") ?? undefined, variables: p.get("variables") ?? undefined, operationName: p.get("operationName") ?? undefined };
    } else if (method === "POST") {
      let text;
      if (init?.body !== undefined && init.body !== null) text = typeof init.body === "string" ? init.body : await new Response(init.body).text();
      else if (typeof input === "object" && input && "clone" in input) text = await input.clone().text();
      else text = "";
      const type = new Headers(init?.headers ?? (typeof input === "object" && input && "headers" in input ? input.headers : undefined)).get("content-type") ?? "";
      if (/application\/graphql\b/i.test(type)) {
        payload = { query: text };
      } else {
        try {
          payload = JSON.parse(text);
        } catch {
          return badRequest("POST body is not valid JSON.");
        }
      }
    } else {
      return badRequest(`GraphQL answers GET and POST, not ${method}.`, 405, "method-not-allowed");
    }

    const batched = Array.isArray(payload);
    if (batched && payload.length === 0) return badRequest("A batch must not be empty.");
    const items = batched ? payload : [payload];

    const outcomes = [];
    for (const item of items) {
      const op = readOperation(item);
      if (op.error) {
        if (!batched) return op.error;
        outcomes.push({ errors: [{ message: "Invalid request in batch.", extensions: { code: "bad-request" } }] });
        continue;
      }
      if (!isMutationAllowed && operationKind(op) === "mutation") {
        return badRequest("Mutations must be sent with POST.", 405, "method-not-allowed");
      }
      const ms = latencyFor(options.latency, seed, op);
      await waitOrAbort(ms, options.delay, signal);
      outcomes.push(world.query(op.query, { variables: op.variables, operationName: op.operationName }));
    }
    return respond(200, batched ? outcomes : outcomes[0]);
  };
  fetchLike.world = world;
  return fetchLike;
}

export { createFetch as default };
