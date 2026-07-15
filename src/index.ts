export { createTypedClient } from "./client.js";
export { generateTypes } from "./codegen.js";
export { bucket, createEvaluator, stableHash } from "./evaluator.js";
export * from "./events.js";
export * from "./experiments.js";
export type {
  LegacyDefinitionOverrides,
  LegacyFlagType,
  LegacyFlagValue,
  LegacyMigrationOptions,
} from "./legacy.js";
export { migrateLegacyFlags } from "./legacy.js";
export { createOpenFeatureProvider } from "./openfeature.js";
export {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy.js";
export { parseConfig, schema, validateConfig } from "./schema.js";
export * from "./telemetry.js";
export * from "./types.js";

import { parseConfig } from "./schema.js";
import type { FlagConfig } from "./types.js";

export function defineConfig<const C extends FlagConfig>(config: C): C {
  parseConfig(config);
  return config;
}
