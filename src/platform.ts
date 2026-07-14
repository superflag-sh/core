import { createTypedClient } from "./client";
import { createEvaluator } from "./evaluator";
import type { EvaluationContext, FlagConfig } from "./types";

export function createPlatformClient<const C extends FlagConfig>(
  config: C,
  context: EvaluationContext,
) {
  return createTypedClient(createEvaluator(config), context);
}
