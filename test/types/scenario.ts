import { graceholder, createWorld, SCENARIOS, type Scenario, type Spec } from "@johnhenry/graceholder";
import { graceholderArbitrary, replay, type GraceholderSample } from "@johnhenry/graceholder/fast-check";

const s: Scenario = "nulls";
const spec: Spec = { "users.posts": { scenario: ["empty", "unicode"] } };
const r = graceholder("{ users { id } }", { scenario: [s, "errors"], scenarioOptions: { errorRate: 0.5 }, errors: "result", spec });
const errs: Array<{ message: string }> = (r.errors ?? []) as Array<{ message: string }>;
const all: readonly Scenario[] = SCENARIOS;
createWorld({ scenario: "huge" });
const arb = graceholderArbitrary("{ users { id } }", { scenarios: ["empty", "nulls"], spec });
const sample: GraceholderSample = replay("{ users { id } }", { seed: 1, scenarios: ["empty"] });
void [errs, all, arb, sample];
