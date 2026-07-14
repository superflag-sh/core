import { createEvaluator } from "./evaluator";
import { createOpenFeatureProvider } from "./openfeature";
import { createPlatformClient } from "./platform";
import {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy";
import { parseConfig, validateConfig } from "./schema";

export const createNodeClient = createPlatformClient;
export type { EvaluationContext, EvaluationDetails, FlagConfig } from "./types";
export {
  createClientSnapshot,
  createEvaluator,
  createOpenFeatureProvider,
  parseConfig,
  projectClientConfig,
  sanitizeContext,
  validateConfig,
};
