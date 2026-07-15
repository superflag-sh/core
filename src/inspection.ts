import {
  createEvaluator,
  type ServeSelection,
  selectServe,
} from "./evaluator.js";
import { parseConfig } from "./schema.js";
import type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationReason,
  Flag,
  FlagConfig,
  FlagValue,
  PrerequisiteEvaluation,
  Schedule,
  Serve,
  TargetingExpression,
} from "./types.js";

export type InspectionInstant = Date | string | number;

export interface EvaluationEligibilityStage {
  stage: "eligibility";
  eligible: boolean;
  reason: EvaluationReason;
  prerequisites: readonly PrerequisiteEvaluation[];
  flagSchedule?: Schedule;
  errorCode?: EvaluationDetails["errorCode"];
}

export interface EvaluationAssignmentStage {
  stage: "assignment";
  attempted: boolean;
  variation?: string;
  ruleId?: string;
  serve: "none" | "variation" | "rollout" | "progressive";
  ruleSchedule?: Schedule;
  progressiveSchedule?: { start: string; end: string };
  bucket?: NonNullable<ServeSelection["bucket"]>;
}

export interface EvaluationResultStage {
  stage: "evaluation";
  details: EvaluationDetails;
}

export interface ExposureCandidateStage {
  stage: "exposure-candidate";
  candidate: boolean;
  flagKey: string;
  variation?: string;
  configVersion: number;
  reason: EvaluationReason;
  ruleId?: string;
}

export interface EvaluationExplanation {
  schemaVersion: FlagConfig["schemaVersion"];
  source: FlagConfig["source"];
  configVersion: number;
  flagKey: string;
  now: string;
  stages: readonly [
    EvaluationEligibilityStage,
    EvaluationAssignmentStage,
    EvaluationResultStage,
    ExposureCandidateStage,
  ];
}

export interface SegmentMembershipResult {
  segmentId: string;
  matched: boolean;
  now: string;
  segmentIds: readonly string[];
  error?: "SEGMENT_NOT_FOUND";
  errorCode?: EvaluationDetails["errorCode"];
  errorMessage?: string;
}

export type ConfigResource =
  | { kind: "flag"; key: string }
  | { kind: "segment"; key: string };

export type ConfigDependencyKind =
  | "flag_prerequisite"
  | "flag_segment"
  | "segment_segment";

export interface ConfigDependencyPath {
  resources: readonly ConfigResource[];
  relationships: readonly ConfigDependencyKind[];
}

export interface EvaluationSimulationScenario {
  id: string;
  flagKey: string;
  context: EvaluationContext;
  fallback: FlagValue;
  now: InspectionInstant;
}

export interface ProposedConfigSimulationResult {
  id: string;
  changed: boolean;
  before: EvaluationExplanation;
  after: EvaluationExplanation;
}

function explicitInstant(value: InspectionInstant): Date {
  const now = new Date(value);
  if (!Number.isFinite(now.getTime()))
    throw new TypeError("Inspection now must be a valid explicit instant");
  return now;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function selectedServe(
  flag: Flag | undefined,
  details: EvaluationDetails,
): { serve: Serve; ruleSchedule?: Schedule } | undefined {
  if (!flag || details.errorCode) return undefined;
  if (details.ruleId) {
    const rule = flag.rules?.find(
      (candidate) => candidate.id === details.ruleId,
    );
    return rule
      ? {
          serve: rule.serve,
          ...(rule.schedule ? { ruleSchedule: rule.schedule } : {}),
        }
      : undefined;
  }
  if (details.reason === "FALLTHROUGH" || details.reason === "SPLIT")
    return { serve: flag.fallthrough };
  return undefined;
}

function serveKind(
  serve: Serve | undefined,
): EvaluationAssignmentStage["serve"] {
  if (!serve) return "none";
  if ("variation" in serve) return "variation";
  if ("rollout" in serve) return "rollout";
  return "progressive";
}

/** Explain one evaluation at an explicit instant using the evaluator as authority. */
export function explainEvaluation(
  input: FlagConfig,
  flagKey: string,
  context: EvaluationContext,
  fallback: FlagValue,
  nowInput: InspectionInstant,
): EvaluationExplanation {
  const config = parseConfig(input);
  const now = explicitInstant(nowInput);
  const details = createEvaluator(config).evaluate(flagKey, context, fallback, {
    now,
  });
  const flag = config.flags[flagKey];
  const selected = selectedServe(flag, details);
  const serve = selected?.serve;
  const selection = serve
    ? selectServe(serve, flagKey, context, now)
    : undefined;
  const eligible =
    details.errorCode === undefined &&
    !new Set<EvaluationReason>([
      "OFF",
      "SCHEDULED_OUT",
      "PREREQUISITE_FAILED",
      "DEFAULT",
    ]).has(details.reason);
  const eligibility: EvaluationEligibilityStage = {
    stage: "eligibility",
    eligible,
    reason: details.reason,
    prerequisites: details.prerequisites,
    ...(flag?.schedule ? { flagSchedule: flag.schedule } : {}),
    ...(details.errorCode ? { errorCode: details.errorCode } : {}),
  };
  const assignment: EvaluationAssignmentStage = {
    stage: "assignment",
    attempted: serve !== undefined,
    serve: serveKind(serve),
    ...(serve && details.variation ? { variation: details.variation } : {}),
    ...(details.ruleId ? { ruleId: details.ruleId } : {}),
    ...(selected?.ruleSchedule ? { ruleSchedule: selected.ruleSchedule } : {}),
    ...(serve && "progressive" in serve
      ? {
          progressiveSchedule: {
            start: serve.progressive.start,
            end: serve.progressive.end,
          },
        }
      : {}),
    ...(selection?.bucket ? { bucket: selection.bucket } : {}),
  };
  const evaluation: EvaluationResultStage = {
    stage: "evaluation",
    details,
  };
  const exposureCandidate: ExposureCandidateStage = {
    stage: "exposure-candidate",
    candidate: eligible && details.variation !== undefined,
    flagKey,
    ...(details.variation ? { variation: details.variation } : {}),
    configVersion: details.configVersion,
    reason: details.reason,
    ...(details.ruleId ? { ruleId: details.ruleId } : {}),
  };
  return {
    schemaVersion: config.schemaVersion,
    source: config.source,
    configVersion: config.configVersion,
    flagKey,
    now: now.toISOString(),
    stages: [eligibility, assignment, evaluation, exposureCandidate],
  };
}

/** Test segment membership through the evaluator's existing expression engine. */
export function testSegmentMembership(
  input: FlagConfig,
  segmentId: string,
  context: EvaluationContext,
  nowInput: InspectionInstant,
): SegmentMembershipResult {
  const config = parseConfig(input);
  const now = explicitInstant(nowInput);
  if (!config.segments?.[segmentId]) {
    return {
      segmentId,
      matched: false,
      now: now.toISOString(),
      segmentIds: [],
      error: "SEGMENT_NOT_FOUND",
    };
  }
  let probeKey = "__superflag_segment_probe__";
  while (config.flags[probeKey]) probeKey = `_${probeKey}`;
  const probe: Flag<boolean> = {
    type: "boolean",
    description: "Internal deterministic segment inspection probe",
    tags: [],
    owner: "superflag-core",
    lifecycle: "active",
    enabled: true,
    visibility: "server",
    variations: {
      outside: { value: false },
      inside: { value: true },
    },
    offVariation: "outside",
    rules: [
      {
        id: "segment-membership",
        when: { op: "segment", segment: segmentId },
        serve: { variation: "inside" },
      },
    ],
    fallthrough: { variation: "outside" },
  };
  const probeConfig: FlagConfig = {
    ...config,
    flags: { ...config.flags, [probeKey]: probe },
  };
  const details = createEvaluator(probeConfig).boolean(
    probeKey,
    context,
    false,
    { now },
  );
  return {
    segmentId,
    matched: details.variation === "inside",
    now: now.toISOString(),
    segmentIds: details.segmentIds,
    ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    ...(details.errorMessage ? { errorMessage: details.errorMessage } : {}),
  };
}

type Edge = {
  from: string;
  to: string;
  kind: ConfigDependencyKind;
};

const resourceId = (resource: ConfigResource): string =>
  `${resource.kind}:${resource.key}`;

const parseResourceId = (value: string): ConfigResource => {
  const separator = value.indexOf(":");
  return {
    kind: value.slice(0, separator) as ConfigResource["kind"],
    key: value.slice(separator + 1),
  };
};

function referencedSegments(expression: TargetingExpression): string[] {
  if (expression.op === "segment") return [expression.segment];
  if (expression.op === "not") return referencedSegments(expression.expression);
  if (expression.op === "all" || expression.op === "any")
    return expression.expressions.flatMap(referencedSegments);
  return [];
}

function dependencyEdges(config: FlagConfig): Edge[] {
  const edges: Edge[] = [];
  for (const [flagKey, flag] of Object.entries(config.flags)) {
    for (const prerequisite of flag.prerequisites ?? []) {
      edges.push({
        from: `flag:${flagKey}`,
        to: `flag:${prerequisite.flag}`,
        kind: "flag_prerequisite",
      });
    }
    for (const segment of new Set(
      (flag.rules ?? []).flatMap((rule) => referencedSegments(rule.when)),
    )) {
      edges.push({
        from: `flag:${flagKey}`,
        to: `segment:${segment}`,
        kind: "flag_segment",
      });
    }
  }
  for (const [segmentKey, segment] of Object.entries(config.segments ?? {})) {
    for (const dependency of new Set(
      (segment.rules ?? []).flatMap(referencedSegments),
    )) {
      edges.push({
        from: `segment:${segmentKey}`,
        to: `segment:${dependency}`,
        kind: "segment_segment",
      });
    }
  }
  return edges.sort((left, right) => {
    const leftKey = `${left.from}\0${left.to}\0${left.kind}`;
    const rightKey = `${right.from}\0${right.to}\0${right.kind}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function walkPaths(
  edges: readonly Edge[],
  start: ConfigResource,
  reverse: boolean,
): ConfigDependencyPath[] {
  const paths: ConfigDependencyPath[] = [];
  const startId = resourceId(start);
  const visit = (
    current: string,
    resources: string[],
    relationships: ConfigDependencyKind[],
  ) => {
    const next = edges.filter((edge) =>
      reverse ? edge.to === current : edge.from === current,
    );
    for (const edge of next) {
      const target = reverse ? edge.from : edge.to;
      if (resources.includes(target)) continue;
      const nextResources = [...resources, target];
      const nextRelationships = [...relationships, edge.kind];
      paths.push({
        resources: nextResources.map(parseResourceId),
        relationships: nextRelationships,
      });
      visit(target, nextResources, nextRelationships);
    }
  };
  visit(startId, [startId], []);
  return paths;
}

/** Return deterministic direct and transitive paths from a resource to its dependencies. */
export function dependencyPaths(
  input: FlagConfig,
  resource: ConfigResource,
): ConfigDependencyPath[] {
  const config = parseConfig(input);
  return walkPaths(dependencyEdges(config), resource, false);
}

/** Return deterministic direct and transitive paths from a changed resource to consumers. */
export function impactPaths(
  input: FlagConfig,
  changed: ConfigResource,
): ConfigDependencyPath[] {
  const config = parseConfig(input);
  return walkPaths(dependencyEdges(config), changed, true);
}

/** Compare current and proposed config using the exact same evaluator/explain path. */
export function simulateProposedConfig(
  currentInput: FlagConfig,
  proposedInput: FlagConfig,
  scenarios: readonly EvaluationSimulationScenario[],
): ProposedConfigSimulationResult[] {
  const current = parseConfig(currentInput);
  const proposed = parseConfig(proposedInput);
  return scenarios.map((scenario) => {
    const before = explainEvaluation(
      current,
      scenario.flagKey,
      scenario.context,
      scenario.fallback,
      scenario.now,
    );
    const after = explainEvaluation(
      proposed,
      scenario.flagKey,
      scenario.context,
      scenario.fallback,
      scenario.now,
    );
    const beforeDetails = before.stages[2].details;
    const afterDetails = after.stages[2].details;
    return {
      id: scenario.id,
      changed:
        canonicalJson({
          value: beforeDetails.value,
          variation: beforeDetails.variation,
          reason: beforeDetails.reason,
          ruleId: beforeDetails.ruleId,
          segmentIds: beforeDetails.segmentIds,
          prerequisites: beforeDetails.prerequisites,
          errorCode: beforeDetails.errorCode,
        }) !==
        canonicalJson({
          value: afterDetails.value,
          variation: afterDetails.variation,
          reason: afterDetails.reason,
          ruleId: afterDetails.ruleId,
          segmentIds: afterDetails.segmentIds,
          prerequisites: afterDetails.prerequisites,
          errorCode: afterDetails.errorCode,
        }),
      before,
      after,
    };
  });
}
