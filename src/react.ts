import type { TypedClient } from "./client";
import { createPlatformClient } from "./platform";
import {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy";

export type { TypedClient };
export const createReactClient = createPlatformClient;
export type { EvaluationContext, EvaluationDetails, FlagConfig } from "./types";
export { createClientSnapshot, projectClientConfig, sanitizeContext };
