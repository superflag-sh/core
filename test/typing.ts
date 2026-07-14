import { createTypedClient } from "../src/client";
import { conformanceConfig } from "../src/conformance";
import { createEvaluator } from "../src/evaluator";

const client = createTypedClient(createEvaluator(conformanceConfig), {
  targetingKey: "typecheck-user",
});

client.get("checkout", false);
client.details("progressive", "control");

// @ts-expect-error Generated/literal config types reject unknown flag keys.
client.get("unknown-flag", false);

// @ts-expect-error Typed fallbacks must match the declared flag value type.
client.get("checkout", "not-a-boolean");
