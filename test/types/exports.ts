import { graceholder, createWorld, inferSchema, specFromSamples, analyzeSamples, GraceholderError, KEY_SCHEME, type Options, type InferResult, type World, type ExportedWorld, type Spec, type SampleNote } from "@johnhenry/graceholder";

const k: "gh1" = KEY_SCHEME;
const opts: Options = { seed: 1, variables: { a: 1 }, anchorDate: new Date(0), locale: "en" };
const data: Record<string, unknown> = graceholder("{ users { id } }", { seed: 1 });
void opts;
const res = graceholder("{ users { id } }", { errors: "result" });
const maybe: unknown = res.data;
const inferred: InferResult = inferSchema("{ users { id } }");
const sdl: string = inferred.sdl;
try {
  graceholder("{");
} catch (e) {
  if (e instanceof GraceholderError) {
    const code: string = e.code;
    void code;
  }
}
const learned: Spec = specFromSamples("{ users { age } }", [{ users: [{ age: 3 }] }], { allowValues: ["users.status"], maxEnum: 8, schema: "type Query { users: [U!]! } type U { age: Int! }" });
const analysed: { spec: Spec; notes: SampleNote[] } = analyzeSamples("{ users { age } }", { data: { users: [] } });
const withSchema: Data2 = graceholder("{ a }", { schema: "type Query { a: Int }" });
type Data2 = Record<string, unknown>;
const decisionSource: string = inferSchema("{ a }", undefined, { schema: "type Query { a: Int }" }).decisions[0].source;
void [k, data, maybe, sdl, learned, analysed, withSchema, decisionSource];

const world: World = createWorld({ seed: "s", spec: { $mutations: { verbs: { archive: "delete" }, position: "start" } } });
const wr = world.query("mutation { createUser(input: { name: \"x\" }) { id } }", { variables: { a: 1 }, operationName: "M" });
const errs: string[] = (wr.errors ?? []).map((e) => e.message);
const exported: ExportedWorld = world.pin("User:1", { name: "A" }).export();
const again: World = createWorld(exported);
void [errs, again.reset()];
import { registerPack, registeredPacks, type Pack, type Distribution } from "@johnhenry/graceholder";
import { geo } from "@johnhenry/graceholder/packs/geo";
import commerce from "@johnhenry/graceholder/packs/commerce";
import { allPacks, finance, health } from "@johnhenry/graceholder/packs";

const pack: Pack = geo;
registerPack(commerce);
const names: string[] = registeredPacks();
const dist: Distribution = "zipf";
const rich = graceholder("{ users { avatar city } }", { packs: [geo, "commerce", finance, health, ...allPacks], images: "svg", distributions: "realistic" });
void [pack, names, dist, rich];

import { stream, toNDJSON, toCSV, toSQL, sqlWriter, type Stream, type StreamOptions, type SqlOptions, type SqlWriter } from "@johnhenry/graceholder";
const sOpts: StreamOptions = { seed: "s", count: 10, offset: 2, chunkSize: 5, field: "users", packs: [] };
const items: Stream = stream("{ users { id } }", sOpts);
const firstItem: Record<string, any> = [...items][0];
const nd: string = [...toNDJSON(items)].join("");
const csv: string = [...toCSV(items, { delimiter: ";", lists: "explode", explode: ["tags"] })].join("");
const sqlOpts: SqlOptions = { dialect: "sqlite", count: 3, ddl: false, names: "preserve" };
const script: string = [...toSQL("{ users { id } }", sqlOpts)].join("");
const writer: SqlWriter = sqlWriter(items, { dialect: "postgres" });
const part: string = writer.header() + [...writer.rows(0, 5)].join("") + writer.footer();
async function consume() {
  for await (const it of items) void it;
}
const fromWorld: Stream = world.stream("{ users { id } }", { count: 2, chunkSize: 1 });
void [firstItem, nd, csv, script, part, consume, fromWorld];
