import { createEvaluator } from "./evaluator";
import type {
  EvaluationContext,
  FlagConfig,
  FlagValue,
  JsonValue,
} from "./types";

export interface OpenFeatureEvaluationContext {
  targetingKey?: string;
  [key: string]: unknown;
}

export interface OpenFeatureResolutionDetails<T> {
  value: T;
  variant?: string | undefined;
  reason?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  flagMetadata?:
    | Readonly<Record<string, string | number | boolean>>
    | undefined;
}

export interface OpenFeatureProvider {
  readonly metadata: { readonly name: string };
  readonly runsOn: "server";
  initialize(context?: OpenFeatureEvaluationContext): Promise<void>;
  onClose(): Promise<void>;
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OpenFeatureEvaluationContext,
    logger?: unknown,
  ): Promise<OpenFeatureResolutionDetails<boolean>>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OpenFeatureEvaluationContext,
    logger?: unknown,
  ): Promise<OpenFeatureResolutionDetails<string>>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OpenFeatureEvaluationContext,
    logger?: unknown,
  ): Promise<OpenFeatureResolutionDetails<number>>;
  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureEvaluationContext,
    logger?: unknown,
  ): Promise<OpenFeatureResolutionDetails<T>>;
}

function contextFromOpenFeature(
  context: OpenFeatureEvaluationContext,
): EvaluationContext {
  const { targetingKey, ...attributes } = context;
  return {
    targetingKey: targetingKey ?? "",
    ...(Object.keys(attributes).length > 0
      ? {
          attributes: attributes as NonNullable<
            EvaluationContext["attributes"]
          >,
        }
      : {}),
  };
}

const reasonMap = {
  OFF: "DISABLED",
  TARGETING_MATCH: "TARGETING_MATCH",
  SPLIT: "SPLIT",
  FALLTHROUGH: "DEFAULT",
  PREREQUISITE_FAILED: "TARGETING_MATCH",
  SCHEDULED_OUT: "DISABLED",
  DEFAULT: "ERROR",
} as const;

const errorMap = {
  FLAG_NOT_FOUND: "FLAG_NOT_FOUND",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  INVALID_CONTEXT: "TARGETING_KEY_MISSING",
  INVALID_CONFIG: "GENERAL",
  CYCLE_DETECTED: "GENERAL",
  EVALUATION_ERROR: "GENERAL",
} as const;

function openFeatureMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function evaluationMetadata(details: {
  metadata?: Readonly<Record<string, JsonValue>> | undefined;
  source: { app: string; environment: string };
  configVersion: number;
  ruleId?: string | undefined;
}): Readonly<Record<string, string | number | boolean>> {
  return {
    ...openFeatureMetadata(details.metadata),
    "superflag.source.app": details.source.app,
    "superflag.source.environment": details.source.environment,
    "superflag.configVersion": details.configVersion,
    ...(details.ruleId ? { "superflag.ruleId": details.ruleId } : {}),
  };
}

/**
 * Structurally compatible with @openfeature/server-sdk's Provider interface.
 * The SDK is an optional peer: importing this module never loads it.
 */
export function createOpenFeatureProvider(
  config: FlagConfig,
): OpenFeatureProvider {
  const evaluator = createEvaluator(config);
  const resolve = <T extends FlagValue>(
    flagKey: string,
    defaultValue: T,
    context: OpenFeatureEvaluationContext,
  ): OpenFeatureResolutionDetails<T> => {
    const details = evaluator.evaluate(
      flagKey,
      contextFromOpenFeature(context),
      defaultValue,
    );
    return {
      value: details.value as T,
      variant: details.variation,
      reason: reasonMap[details.reason],
      errorCode: details.errorCode ? errorMap[details.errorCode] : undefined,
      errorMessage: details.errorMessage,
      flagMetadata: evaluationMetadata(details),
    };
  };
  return {
    metadata: { name: "@superflag-sh/core" },
    runsOn: "server" as const,
    initialize: async () => undefined,
    onClose: async () => undefined,
    resolveBooleanEvaluation: async (
      flagKey: string,
      defaultValue: boolean,
      context: OpenFeatureEvaluationContext,
    ) => resolve(flagKey, defaultValue, context),
    resolveStringEvaluation: async (
      flagKey: string,
      defaultValue: string,
      context: OpenFeatureEvaluationContext,
    ) => resolve(flagKey, defaultValue, context),
    resolveNumberEvaluation: async (
      flagKey: string,
      defaultValue: number,
      context: OpenFeatureEvaluationContext,
    ) => resolve(flagKey, defaultValue, context),
    resolveObjectEvaluation: async <T extends JsonValue>(
      flagKey: string,
      defaultValue: T,
      context: OpenFeatureEvaluationContext,
    ) => {
      const details = evaluator.object(
        flagKey,
        contextFromOpenFeature(context),
        defaultValue,
      );
      return {
        value: details.value,
        variant: details.variation,
        reason: reasonMap[details.reason],
        errorCode: details.errorCode ? errorMap[details.errorCode] : undefined,
        errorMessage: details.errorMessage,
        flagMetadata: evaluationMetadata(details),
      };
    },
  };
}
