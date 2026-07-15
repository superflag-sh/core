import { createEvaluator } from "./evaluator.js";
import { parseConfig } from "./schema.js";
import type {
  ConfigSource,
  EvaluationContext,
  EvaluationReason,
  Flag,
  FlagConfig,
  JsonValue,
  MatchOperator,
  TargetingExpression,
  ValidationIssue,
  ValidationResult,
  WeightedVariation,
} from "./types.js";

export const EXPERIMENT_SCHEMA_VERSION = 1 as const;

export type ExperimentLifecycle =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "archived";

export interface MetricRevisionReference {
  key: string;
  revision: number;
}

export type ExperimentAudienceReference =
  | { kind: "all" }
  | { kind: "segment"; segment: string };

export type ExperimentAssignmentUnit =
  | { kind: "targetingKey" }
  | { kind: "attribute"; attribute: string };

export interface Experiment {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  id: string;
  source: ConfigSource;
  lifecycle: ExperimentLifecycle;
  hypothesis: string;
  owner: string;
  flagKey: string;
  audience: ExperimentAudienceReference;
  assignmentUnit: ExperimentAssignmentUnit;
  primaryMetric: MetricRevisionReference;
  secondaryMetrics: readonly MetricRevisionReference[];
  guardrailMetrics: readonly MetricRevisionReference[];
  intendedDurationDays: number;
  sampleTarget: number;
}

export type ExperimentAudienceSnapshot =
  | { kind: "all"; id: string; version: number }
  | {
      kind: "expression";
      id: string;
      version: number;
      expression: TargetingExpression;
    };

export interface ExperimentIteration {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  id: string;
  experimentId: string;
  number: number;
  source: ConfigSource;
  flagKey: string;
  configVersion: number;
  variations: readonly string[];
  allocation: readonly WeightedVariation[];
  salt: string;
  assignmentUnit: ExperimentAssignmentUnit;
  audience: ExperimentAudienceSnapshot;
  primaryMetric: MetricRevisionReference;
  secondaryMetrics: readonly MetricRevisionReference[];
  guardrailMetrics: readonly MetricRevisionReference[];
  startedAt: string;
}

export interface ExperimentAssignment {
  experimentId: string;
  iterationId: string;
  flagKey: string;
  configVersion: number;
  variation?: string;
  reason: EvaluationReason;
  eligible: boolean;
}

const lifecycles = new Set<ExperimentLifecycle>([
  "draft",
  "running",
  "paused",
  "completed",
  "archived",
]);
const lifecycleTransitions: Readonly<
  Record<ExperimentLifecycle, ReadonlySet<ExperimentLifecycle>>
> = {
  draft: new Set(["running", "archived"]),
  running: new Set(["paused", "completed"]),
  paused: new Set(["running", "completed"]),
  completed: new Set(["archived"]),
  archived: new Set(),
};
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_TEXT = 2_000;
const MAX_NAME = 128;
const MAX_EXPRESSION_DEPTH = 16;
const operators = new Set<MatchOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "matches",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "semverEq",
  "semverGt",
  "semverGte",
  "semverLt",
  "semverLte",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_NAME;
const validText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_TEXT;
const isJson = (value: unknown): value is JsonValue => {
  if (value === null || ["string", "boolean"].includes(typeof value))
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
};

function validateSource(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ConfigSource {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (!validName(value.app))
    issues.push({ path: `${path}.app`, message: "must be a bounded name" });
  if (!validName(value.environment))
    issues.push({
      path: `${path}.environment`,
      message: "must be a bounded name",
    });
  return true;
}

function validateMetric(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is MetricRevisionReference {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (!validName(value.key))
    issues.push({ path: `${path}.key`, message: "must be a bounded name" });
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    issues.push({
      path: `${path}.revision`,
      message: "must be a positive safe integer",
    });
  return true;
}

function validateMetricList(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is readonly MetricRevisionReference[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return false;
  }
  value.forEach((entry, index) =>
    validateMetric(entry, `${path}[${index}]`, issues),
  );
  const keys = value
    .filter(isRecord)
    .map((entry) => `${String(entry.key)}:${String(entry.revision)}`);
  if (new Set(keys).size !== keys.length)
    issues.push({ path, message: "must not contain duplicate revisions" });
  return true;
}

function metricRevisionIdentity(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !validName(value.key) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1
  )
    return undefined;
  return `${value.key}:${value.revision}`;
}

function validateMetricRoles(
  primary: unknown,
  secondary: unknown,
  guardrail: unknown,
  issues: ValidationIssue[],
): void {
  const seen = new Map<string, string>();
  const entries: Array<{ path: string; value: unknown }> = [
    { path: "$.primaryMetric", value: primary },
    ...(Array.isArray(secondary)
      ? secondary.map((value, index) => ({
          path: `$.secondaryMetrics[${index}]`,
          value,
        }))
      : []),
    ...(Array.isArray(guardrail)
      ? guardrail.map((value, index) => ({
          path: `$.guardrailMetrics[${index}]`,
          value,
        }))
      : []),
  ];
  for (const entry of entries) {
    const identity = metricRevisionIdentity(entry.value);
    if (!identity) continue;
    const firstPath = seen.get(identity);
    if (firstPath) {
      issues.push({
        path: entry.path,
        message: `must not duplicate the metric revision at ${firstPath}`,
      });
    } else seen.set(identity, entry.path);
  }
}

function validateAssignmentUnit(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ExperimentAssignmentUnit {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (value.kind === "targetingKey") return true;
  if (value.kind === "attribute") {
    if (!validName(value.attribute))
      issues.push({
        path: `${path}.attribute`,
        message: "must be a bounded attribute path",
      });
    return true;
  }
  issues.push({ path: `${path}.kind`, message: "is not supported" });
  return false;
}

function validateAudienceReference(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ExperimentAudienceReference {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (value.kind === "all") return true;
  if (value.kind === "segment") {
    if (!validName(value.segment))
      issues.push({
        path: `${path}.segment`,
        message: "must be a bounded segment id",
      });
    return true;
  }
  issues.push({ path: `${path}.kind`, message: "is not supported" });
  return false;
}

function validateExpressionShape(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  depth = 0,
): value is TargetingExpression {
  if (depth > MAX_EXPRESSION_DEPTH) {
    issues.push({ path, message: "exceeds the maximum nesting depth" });
    return false;
  }
  if (!isRecord(value) || typeof value.op !== "string") {
    issues.push({ path, message: "must be a targeting expression snapshot" });
    return false;
  }
  if (value.op === "all" || value.op === "any") {
    if (!Array.isArray(value.expressions))
      issues.push({ path: `${path}.expressions`, message: "must be an array" });
    else
      value.expressions.forEach((entry, index) =>
        validateExpressionShape(
          entry,
          `${path}.expressions[${index}]`,
          issues,
          depth + 1,
        ),
      );
  } else if (value.op === "not")
    validateExpressionShape(
      value.expression,
      `${path}.expression`,
      issues,
      depth + 1,
    );
  else if (value.op === "segment") {
    if (!validName(value.segment))
      issues.push({
        path: `${path}.segment`,
        message: "must be a bounded segment id",
      });
    if (value.negate !== undefined && typeof value.negate !== "boolean")
      issues.push({
        path: `${path}.negate`,
        message: "must be a boolean",
      });
  } else if (value.op === "match") {
    if (!validName(value.attribute))
      issues.push({
        path: `${path}.attribute`,
        message: "must be a bounded attribute path",
      });
    if (!operators.has(value.operator as MatchOperator))
      issues.push({
        path: `${path}.operator`,
        message: "is not supported",
      });
    if (value.operator !== "exists" && value.value === undefined)
      issues.push({
        path: `${path}.value`,
        message: "is required for this operator",
      });
    if (value.value !== undefined && !isJson(value.value))
      issues.push({
        path: `${path}.value`,
        message: "must be a JSON-compatible attribute value",
      });
  } else issues.push({ path: `${path}.op`, message: "is not supported" });
  return true;
}

function validateAudienceSnapshot(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ExperimentAudienceSnapshot {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (!validName(value.id))
    issues.push({ path: `${path}.id`, message: "must be a bounded id" });
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
    issues.push({
      path: `${path}.version`,
      message: "must be a positive safe integer",
    });
  if (value.kind === "all") {
    if (value.expression !== undefined)
      issues.push({
        path: `${path}.expression`,
        message: "must be omitted for an all-subject audience",
      });
  } else if (value.kind === "expression") {
    if (value.expression === undefined)
      issues.push({
        path: `${path}.expression`,
        message: "is required for an expression audience",
      });
    else
      validateExpressionShape(value.expression, `${path}.expression`, issues);
  } else {
    issues.push({ path: `${path}.kind`, message: "is not supported" });
  }
  return true;
}

function projectSource(value: unknown): ConfigSource {
  const source = value as Record<string, unknown>;
  return {
    app: source.app as string,
    environment: source.environment as string,
  };
}

function projectMetric(value: unknown): MetricRevisionReference {
  const metric = value as Record<string, unknown>;
  return { key: metric.key as string, revision: metric.revision as number };
}

function projectMetricList(value: unknown): readonly MetricRevisionReference[] {
  return (value as unknown[]).map(projectMetric);
}

function projectAssignmentUnit(value: unknown): ExperimentAssignmentUnit {
  const unit = value as Record<string, unknown>;
  return unit.kind === "targetingKey"
    ? { kind: "targetingKey" }
    : { kind: "attribute", attribute: unit.attribute as string };
}

function projectAudienceReference(value: unknown): ExperimentAudienceReference {
  const audience = value as Record<string, unknown>;
  return audience.kind === "all"
    ? { kind: "all" }
    : { kind: "segment", segment: audience.segment as string };
}

function projectExpression(value: unknown): TargetingExpression {
  const expression = value as Record<string, unknown>;
  if (expression.op === "all" || expression.op === "any") {
    return {
      op: expression.op,
      expressions: (expression.expressions as unknown[]).map(projectExpression),
    };
  }
  if (expression.op === "not") {
    return { op: "not", expression: projectExpression(expression.expression) };
  }
  if (expression.op === "segment") {
    return {
      op: "segment",
      segment: expression.segment as string,
      ...(expression.negate !== undefined
        ? { negate: expression.negate as boolean }
        : {}),
    };
  }
  return {
    op: "match",
    attribute: expression.attribute as string,
    operator: expression.operator as MatchOperator,
    ...(expression.value !== undefined
      ? { value: expression.value as JsonValue }
      : {}),
  };
}

function projectAudienceSnapshot(value: unknown): ExperimentAudienceSnapshot {
  const audience = value as Record<string, unknown>;
  const common = {
    id: audience.id as string,
    version: audience.version as number,
  };
  return audience.kind === "all"
    ? { kind: "all", ...common }
    : {
        kind: "expression",
        ...common,
        expression: projectExpression(audience.expression),
      };
}

function projectExperiment(value: Record<string, unknown>): Experiment {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    id: value.id as string,
    source: projectSource(value.source),
    lifecycle: value.lifecycle as ExperimentLifecycle,
    hypothesis: value.hypothesis as string,
    owner: value.owner as string,
    flagKey: value.flagKey as string,
    audience: projectAudienceReference(value.audience),
    assignmentUnit: projectAssignmentUnit(value.assignmentUnit),
    primaryMetric: projectMetric(value.primaryMetric),
    secondaryMetrics: projectMetricList(value.secondaryMetrics),
    guardrailMetrics: projectMetricList(value.guardrailMetrics),
    intendedDurationDays: value.intendedDurationDays as number,
    sampleTarget: value.sampleTarget as number,
  };
}

function projectExperimentIteration(
  value: Record<string, unknown>,
): ExperimentIteration {
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    id: value.id as string,
    experimentId: value.experimentId as string,
    number: value.number as number,
    source: projectSource(value.source),
    flagKey: value.flagKey as string,
    configVersion: value.configVersion as number,
    variations: [...(value.variations as string[])],
    allocation: (value.allocation as Array<Record<string, unknown>>).map(
      (item) => ({
        variation: item.variation as string,
        weight: item.weight as number,
      }),
    ),
    salt: value.salt as string,
    assignmentUnit: projectAssignmentUnit(value.assignmentUnit),
    audience: projectAudienceSnapshot(value.audience),
    primaryMetric: projectMetric(value.primaryMetric),
    secondaryMetrics: projectMetricList(value.secondaryMetrics),
    guardrailMetrics: projectMetricList(value.guardrailMetrics),
    startedAt: value.startedAt as string,
  };
}

export function validateExperiment(
  input: unknown,
): ValidationResult<Experiment> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input))
    return {
      success: false,
      issues: [{ path: "$", message: "must be an object" }],
    };
  if (input.schemaVersion !== EXPERIMENT_SCHEMA_VERSION)
    issues.push({ path: "$.schemaVersion", message: "must equal 1" });
  if (!validName(input.id))
    issues.push({ path: "$.id", message: "must be a bounded id" });
  validateSource(input.source, "$.source", issues);
  if (!lifecycles.has(input.lifecycle as ExperimentLifecycle))
    issues.push({ path: "$.lifecycle", message: "is not supported" });
  if (!validText(input.hypothesis))
    issues.push({ path: "$.hypothesis", message: "must be bounded text" });
  if (!validName(input.owner))
    issues.push({ path: "$.owner", message: "must be a bounded name" });
  if (!validName(input.flagKey))
    issues.push({ path: "$.flagKey", message: "must be a bounded name" });
  validateAudienceReference(input.audience, "$.audience", issues);
  validateAssignmentUnit(input.assignmentUnit, "$.assignmentUnit", issues);
  validateMetric(input.primaryMetric, "$.primaryMetric", issues);
  validateMetricList(input.secondaryMetrics, "$.secondaryMetrics", issues);
  validateMetricList(input.guardrailMetrics, "$.guardrailMetrics", issues);
  validateMetricRoles(
    input.primaryMetric,
    input.secondaryMetrics,
    input.guardrailMetrics,
    issues,
  );
  if (
    !Number.isSafeInteger(input.intendedDurationDays) ||
    (input.intendedDurationDays as number) < 1
  )
    issues.push({
      path: "$.intendedDurationDays",
      message: "must be a positive safe integer",
    });
  if (
    !Number.isSafeInteger(input.sampleTarget) ||
    (input.sampleTarget as number) < 1
  )
    issues.push({
      path: "$.sampleTarget",
      message: "must be a positive safe integer",
    });
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, value: projectExperiment(input) };
}

export function parseExperiment(input: unknown): Experiment {
  const result = validateExperiment(input);
  if (result.success) return result.value;
  throw new TypeError(
    `Invalid experiment: ${result.issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ")}`,
  );
}

/** Validates an explicit lifecycle state change against the experiment graph. */
export function validateExperimentLifecycleTransition(
  previous: ExperimentLifecycle,
  next: ExperimentLifecycle,
): ValidationResult<ExperimentLifecycle> {
  if (lifecycleTransitions[previous]?.has(next)) {
    return { success: true, value: next };
  }
  return {
    success: false,
    issues: [
      {
        path: "$.lifecycle",
        message: `cannot transition from ${previous} to ${next}`,
      },
    ],
  };
}

export function validateExperimentIteration(
  input: unknown,
): ValidationResult<ExperimentIteration> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input))
    return {
      success: false,
      issues: [{ path: "$", message: "must be an object" }],
    };
  if (input.schemaVersion !== EXPERIMENT_SCHEMA_VERSION)
    issues.push({ path: "$.schemaVersion", message: "must equal 1" });
  for (const field of ["id", "experimentId", "flagKey", "salt"] as const)
    if (!validName(input[field]))
      issues.push({ path: `$.${field}`, message: "must be a bounded value" });
  validateSource(input.source, "$.source", issues);
  if (!Number.isSafeInteger(input.number) || (input.number as number) < 1)
    issues.push({
      path: "$.number",
      message: "must be a positive safe integer",
    });
  if (
    !Number.isSafeInteger(input.configVersion) ||
    (input.configVersion as number) < 0
  )
    issues.push({
      path: "$.configVersion",
      message: "must be a non-negative safe integer",
    });
  const variationIds = Array.isArray(input.variations)
    ? input.variations.filter((value): value is string => validName(value))
    : [];
  if (
    !Array.isArray(input.variations) ||
    variationIds.length !== input.variations.length ||
    variationIds.length < 2
  )
    issues.push({
      path: "$.variations",
      message: "must contain at least two bounded variation ids",
    });
  else if (new Set(variationIds).size !== variationIds.length)
    issues.push({ path: "$.variations", message: "must be unique" });
  if (!Array.isArray(input.allocation) || input.allocation.length < 2)
    issues.push({
      path: "$.allocation",
      message: "must contain at least two allocations",
    });
  else {
    let total = 0;
    const allocated = new Set<string>();
    input.allocation.forEach((entry, index) => {
      const path = `$.allocation[${index}]`;
      if (!isRecord(entry)) {
        issues.push({ path, message: "must be an object" });
        return;
      }
      if (
        !validName(entry.variation) ||
        !variationIds.includes(entry.variation)
      )
        issues.push({
          path: `${path}.variation`,
          message: "must reference a pinned variation",
        });
      else if (allocated.has(entry.variation))
        issues.push({
          path: `${path}.variation`,
          message: "must be unique",
        });
      else allocated.add(entry.variation);
      if (!Number.isInteger(entry.weight) || (entry.weight as number) < 0)
        issues.push({
          path: `${path}.weight`,
          message: "must be a non-negative integer",
        });
      else total += entry.weight as number;
    });
    if (total <= 0 || total > 100_000)
      issues.push({
        path: "$.allocation",
        message: "weights must total between 1 and 100000",
      });
    if (allocated.size !== variationIds.length)
      issues.push({
        path: "$.allocation",
        message: "must allocate every pinned variation",
      });
  }
  validateAssignmentUnit(input.assignmentUnit, "$.assignmentUnit", issues);
  validateAudienceSnapshot(input.audience, "$.audience", issues);
  validateMetric(input.primaryMetric, "$.primaryMetric", issues);
  validateMetricList(input.secondaryMetrics, "$.secondaryMetrics", issues);
  validateMetricList(input.guardrailMetrics, "$.guardrailMetrics", issues);
  validateMetricRoles(
    input.primaryMetric,
    input.secondaryMetrics,
    input.guardrailMetrics,
    issues,
  );
  if (
    typeof input.startedAt !== "string" ||
    !ISO_INSTANT.test(input.startedAt) ||
    !Number.isFinite(Date.parse(input.startedAt))
  )
    issues.push({
      path: "$.startedAt",
      message: "must be an ISO-8601 instant",
    });
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, value: projectExperimentIteration(input) };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Parsed iterations are recursively frozen to make snapshot mutation explicit. */
export function parseExperimentIteration(input: unknown): ExperimentIteration {
  const result = validateExperimentIteration(input);
  if (!result.success)
    throw new TypeError(
      `Invalid experiment iteration: ${result.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  return deepFreeze(structuredClone(result.value));
}

function bucketBy(unit: ExperimentAssignmentUnit): string {
  return unit.kind === "targetingKey" ? "targetingKey" : unit.attribute;
}

/** Pure A/B/n assignment delegated to the canonical flag evaluator. */
export function assignExperiment(
  rawIteration: ExperimentIteration,
  rawConfig: FlagConfig,
  context: EvaluationContext,
): ExperimentAssignment {
  const iteration = parseExperimentIteration(rawIteration);
  const config = parseConfig(rawConfig);
  if (
    config.source.app !== iteration.source.app ||
    config.source.environment !== iteration.source.environment ||
    config.configVersion !== iteration.configVersion
  )
    throw new TypeError(
      "The iteration requires its pinned config source and version",
    );
  const flag = config.flags[iteration.flagKey] as Flag | undefined;
  if (!flag) throw new TypeError(`Flag ${iteration.flagKey} was not found`);
  for (const variation of iteration.variations)
    if (!flag.variations[variation])
      throw new TypeError(`Pinned variation ${variation} was not found`);

  const rollout = {
    variations: iteration.allocation,
    bucketBy: bucketBy(iteration.assignmentUnit),
    salt: iteration.salt,
  } as const;
  const experimentFlag: Flag = {
    ...flag,
    rules:
      iteration.audience.kind === "expression"
        ? [
            {
              id: `experiment:${iteration.id}`,
              when: iteration.audience.expression,
              serve: { rollout },
            },
          ]
        : [],
    fallthrough:
      iteration.audience.kind === "expression"
        ? { variation: flag.offVariation }
        : { rollout },
  };
  const experimentConfig: FlagConfig = {
    ...config,
    flags: { ...config.flags, [iteration.flagKey]: experimentFlag },
  };
  const fallback = flag.variations[flag.offVariation]?.value;
  if (fallback === undefined)
    throw new TypeError(`Flag ${iteration.flagKey} has no off variation value`);
  const details = createEvaluator(experimentConfig).evaluate(
    iteration.flagKey,
    context,
    fallback,
    { now: iteration.startedAt },
  );
  const eligible =
    details.reason === "SPLIT" && details.errorCode === undefined;
  return {
    experimentId: iteration.experimentId,
    iterationId: iteration.id,
    flagKey: iteration.flagKey,
    configVersion: iteration.configVersion,
    ...(eligible && details.variation ? { variation: details.variation } : {}),
    reason: details.reason,
    eligible,
  };
}

function assignmentIdentity(iteration: ExperimentIteration): unknown {
  const { allocation: _allocation, ...identity } = iteration;
  return identity;
}

/**
 * A ramp is assignment-preserving only when prior bucket boundaries do not move.
 * The previous allocation must be a prefix; only its final weight may grow.
 */
export function isAssignmentPreservingRamp(
  previous: ExperimentIteration,
  next: ExperimentIteration,
): boolean {
  if (
    JSON.stringify(assignmentIdentity(previous)) !==
    JSON.stringify(assignmentIdentity(next))
  )
    return false;
  if (next.allocation.length !== previous.allocation.length) return false;
  for (let index = 0; index < previous.allocation.length; index++) {
    const before = previous.allocation[index];
    const after = next.allocation[index];
    if (!before || !after || before.variation !== after.variation) return false;
    if (
      index < previous.allocation.length - 1 &&
      before.weight !== after.weight
    )
      return false;
    if (
      index === previous.allocation.length - 1 &&
      after.weight < before.weight
    )
      return false;
  }
  const total = next.allocation.reduce((sum, item) => sum + item.weight, 0);
  return total <= 100_000;
}

/** Started iterations accept only a proven boundary-preserving allocation ramp. */
export function validateIterationReplacement(
  previous: ExperimentIteration,
  next: ExperimentIteration,
  lifecycle: ExperimentLifecycle,
): ValidationResult<ExperimentIteration> {
  const validated = validateExperimentIteration(next);
  if (!validated.success || lifecycle === "draft") return validated;
  if (JSON.stringify(previous) === JSON.stringify(validated.value)) {
    return validated;
  }
  if (isAssignmentPreservingRamp(previous, validated.value)) return validated;
  return {
    success: false,
    issues: [
      {
        path: "$",
        message:
          "a started iteration is immutable except for a boundary-preserving allocation ramp; create a new iteration for other changes",
      },
    ],
  };
}
