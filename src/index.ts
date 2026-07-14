export { createTypedClient } from "./client";
export { generateTypes } from "./codegen";
export { bucket, createEvaluator, stableHash } from "./evaluator";
export type {
  LegacyDefinitionOverrides,
  LegacyFlagType,
  LegacyFlagValue,
  LegacyMigrationOptions,
} from "./legacy";
export { migrateLegacyFlags } from "./legacy";
export { createOpenFeatureProvider } from "./openfeature";
export {
  createClientSnapshot,
  projectClientConfig,
  sanitizeContext,
} from "./privacy";
export { parseConfig, schema, validateConfig } from "./schema";
export * from "./types";

import { parseConfig } from "./schema";
import type { FlagConfig } from "./types";

export function defineConfig<const C extends FlagConfig>(config: C): C {
  parseConfig(config);
  return config;
}
