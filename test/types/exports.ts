import { graceholder, createWorld, inferSchema, GraceholderError, KEY_SCHEME, type Options, type InferResult, type World, type ExportedWorld } from "@johnhenry/graceholder";

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
void [k, data, maybe, sdl];

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
