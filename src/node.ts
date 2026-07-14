import { createEvaluator } from "./evaluator.js";
import { createOpenFeatureProvider } from "./openfeature.js";
import { createPlatformClient } from "./platform.js";
import {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy.js";
import { parseConfig, validateConfig } from "./schema.js";

export const createNodeClient = createPlatformClient;
export type {
  EvaluationContext,
  EvaluationDetails,
  FlagConfig,
} from "./types.js";
export {
  createClientSnapshot,
  createEvaluator,
  createOpenFeatureProvider,
  parseConfig,
  projectClientConfig,
  sanitizeContext,
  validateConfig,
};
