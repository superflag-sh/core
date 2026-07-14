import { createTypedClient } from "./client.js";
import { createEvaluator } from "./evaluator.js";
import type { EvaluationContext, FlagConfig } from "./types.js";

export function createPlatformClient<const C extends FlagConfig>(
  config: C,
  context: EvaluationContext,
) {
  return createTypedClient(createEvaluator(config), context);
}
