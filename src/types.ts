export const SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type FlagValue = Exclude<JsonValue, null>;
export type AttributeValue = JsonValue;

export interface EvaluationContext {
  targetingKey: string;
  attributes?: Readonly<Record<string, AttributeValue>>;
}

export type MatchOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "matches"
  | "exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after"
  | "semverEq"
  | "semverGt"
  | "semverGte"
  | "semverLt"
  | "semverLte";

export type TargetingExpression =
  | { op: "all"; expressions: readonly TargetingExpression[] }
  | { op: "any"; expressions: readonly TargetingExpression[] }
  | { op: "not"; expression: TargetingExpression }
  | {
      op: "match";
      attribute: string;
      operator: MatchOperator;
      value?: AttributeValue;
    }
  | { op: "segment"; segment: string; negate?: boolean };

export interface Schedule {
  /** Inclusive ISO-8601 instant. */
  start?: string;
  /** Exclusive ISO-8601 instant. */
  end?: string;
}

export interface Variation<T extends FlagValue = FlagValue> {
  value: T;
  name?: string;
  description?: string;
}

export type FlagValueType = "boolean" | "string" | "number" | "object";
export type FlagLifecycle = "draft" | "active" | "deprecated" | "archived";

export interface FlagDefinition {
  type: FlagValueType;
  description: string;
  tags: readonly string[];
  owner: string;
  lifecycle: FlagLifecycle;
}

export interface WeightedVariation {
  variation: string;
  /** Integer units out of 100,000. Allocations may total less than 100,000. */
  weight: number;
}

export interface Rollout {
  variations: readonly WeightedVariation[];
  bucketBy?: string;
  salt?: string;
}

export interface ProgressiveRollout {
  start: string;
  end: string;
  from: Rollout;
  to: Rollout;
}

export type Serve =
  | { variation: string }
  | { rollout: Rollout }
  | { progressive: ProgressiveRollout };

export interface TargetingRule {
  id: string;
  when: TargetingExpression;
  serve: Serve;
  schedule?: Schedule;
  description?: string;
}

export interface Prerequisite {
  flag: string;
  variations: readonly string[];
}

export interface Flag<T extends FlagValue = FlagValue> extends FlagDefinition {
  enabled: boolean;
  variations: Readonly<Record<string, Variation<T>>>;
  offVariation: string;
  fallthrough: Serve;
  prerequisites?: readonly Prerequisite[];
  rules?: readonly TargetingRule[];
  schedule?: Schedule;
  /** Server is the privacy-preserving default. */
  visibility?: "server" | "client";
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface Segment {
  included?: readonly string[];
  excluded?: readonly string[];
  rules?: readonly TargetingExpression[];
  schedule?: Schedule;
  /** Client-visible flags may only reference client-visible segments. */
  visibility?: "server" | "client";
  description?: string;
}

export interface FlagConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  source: ConfigSource;
  configVersion: number;
  flags: Readonly<Record<string, Flag>>;
  segments?: Readonly<Record<string, Segment>>;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ConfigSource {
  app: string;
  environment: string;
}

export type EvaluationReason =
  | "OFF"
  | "TARGETING_MATCH"
  | "SPLIT"
  | "FALLTHROUGH"
  | "PREREQUISITE_FAILED"
  | "SCHEDULED_OUT"
  | "DEFAULT";

export type EvaluationErrorCode =
  | "FLAG_NOT_FOUND"
  | "TYPE_MISMATCH"
  | "INVALID_CONTEXT"
  | "INVALID_CONFIG"
  | "CYCLE_DETECTED"
  | "EVALUATION_ERROR";

export interface PrerequisiteEvaluation {
  flagKey: string;
  variation?: string | undefined;
  satisfied: boolean;
  reason: EvaluationReason;
}

export interface EvaluationDetails<T extends JsonValue = FlagValue> {
  flagKey: string;
  source: ConfigSource;
  configVersion: number;
  value: T;
  variation?: string | undefined;
  reason: EvaluationReason;
  errorCode?: EvaluationErrorCode | undefined;
  errorMessage?: string | undefined;
  ruleId?: string | undefined;
  segmentIds: readonly string[];
  prerequisites: readonly PrerequisiteEvaluation[];
  timestamp: string;
  metadata?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface EvaluationOptions {
  now?: Date | string | number;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; issues: readonly ValidationIssue[] };

export type FlagKey<C extends FlagConfig> = Extract<keyof C["flags"], string>;
export type FlagValueFor<C extends FlagConfig, K extends FlagKey<C>> =
  C["flags"][K] extends Flag<infer T> ? T : never;

export interface Evaluator<C extends FlagConfig = FlagConfig> {
  evaluate<K extends FlagKey<C>>(
    flagKey: K,
    context: EvaluationContext,
    fallback: FlagValueFor<C, K>,
    options?: EvaluationOptions,
  ): EvaluationDetails<FlagValueFor<C, K>>;
  boolean(
    flagKey: FlagKey<C>,
    context: EvaluationContext,
    fallback: boolean,
    options?: EvaluationOptions,
  ): EvaluationDetails<boolean>;
  string(
    flagKey: FlagKey<C>,
    context: EvaluationContext,
    fallback: string,
    options?: EvaluationOptions,
  ): EvaluationDetails<string>;
  number(
    flagKey: FlagKey<C>,
    context: EvaluationContext,
    fallback: number,
    options?: EvaluationOptions,
  ): EvaluationDetails<number>;
  object<T extends JsonValue>(
    flagKey: FlagKey<C>,
    context: EvaluationContext,
    fallback: T,
    options?: EvaluationOptions,
  ): EvaluationDetails<T>;
}
