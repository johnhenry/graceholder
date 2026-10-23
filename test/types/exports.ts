import { graceholder, inferSchema, GraceholderError, KEY_SCHEME, type Options, type InferResult } from "@johnhenry/graceholder";

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
