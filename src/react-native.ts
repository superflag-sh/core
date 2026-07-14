import type { TypedClient } from "./client.js";
import { createPlatformClient } from "./platform.js";
import {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy.js";

export type { TypedClient };
export const createReactNativeClient = createPlatformClient;
export type {
  EvaluationContext,
  EvaluationDetails,
  FlagConfig,
} from "./types.js";
export { createClientSnapshot, projectClientConfig, sanitizeContext };
