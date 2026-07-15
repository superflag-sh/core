import { stableHash } from "./evaluator.js";
import type {
  ConfigSource,
  EvaluationDetails,
  EvaluationReason,
  JsonValue,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

/** Independent from the frozen feature-config schema version. */
export const FEATURE_EVENT_SCHEMA_VERSION = 1 as const;

export type FeatureEventKind =
  | "decision"
  | "assignment"
  | "exposure"
  | "outcome";

export interface FeatureEventSdk {
  name: string;
  version: string;
  platform: "browser" | "node" | "react-native" | "expo" | "remote";
}

export type PseudonymousSubjectId = `psn_${string}`;

/** An opaque, application-scoped identifier. It must not be a raw targeting key. */
export interface PseudonymousSubject {
  id: PseudonymousSubjectId;
  namespace: string;
  revision: number;
  state: "anonymous" | "authenticated";
}

export interface ExperimentEventReference {
  experimentId: string;
  iterationId: string;
}

export type FeatureEventDimension = string | number | boolean;

interface FeatureEventBase {
  schemaVersion: typeof FEATURE_EVENT_SCHEMA_VERSION;
  id: string;
  kind: FeatureEventKind;
  source: ConfigSource;
  flagKey: string;
  variation: string;
  configVersion: number;
  reason: EvaluationReason;
  timestamp: string;
  sdk: FeatureEventSdk;
  subject: PseudonymousSubject;
  experiment?: ExperimentEventReference;
  /** Rejected unless every key is explicitly allowed by the parser caller. */
  dimensions?: Readonly<Record<string, FeatureEventDimension>>;
}

export interface DecisionEvent extends FeatureEventBase {
  kind: "decision";
}

export interface AssignmentEvent extends FeatureEventBase {
  kind: "assignment";
  experiment: ExperimentEventReference;
}

export interface ExposureEvent extends FeatureEventBase {
  kind: "exposure";
}

export interface OutcomeEvent extends FeatureEventBase {
  kind: "outcome";
  /** The actual exposure that preceded this outcome. */
  exposureId: string;
  metric: { key: string; revision: number };
  value: boolean | number;
}

export type FeatureEvent =
  | DecisionEvent
  | AssignmentEvent
  | ExposureEvent
  | OutcomeEvent;

export interface FeatureEventParserOptions {
  /** Defaults to an empty allow-list. */
  allowedDimensions?: readonly string[];
  maxPayloadBytes?: number;
}

export interface EvaluationEventInput {
  id: string;
  kind: "decision" | "assignment" | "exposure";
  details: EvaluationDetails;
  sdk: FeatureEventSdk;
  subject: PseudonymousSubject;
  experiment?: ExperimentEventReference;
  dimensions?: Readonly<Record<string, FeatureEventDimension>>;
  /** Must name every dimension copied into the event. Defaults closed. */
  allowedDimensions?: readonly string[];
}

export interface SubjectIdentityHooks {
  /** Implementations must use a keyed, non-reversible application-scoped transform. */
  pseudonymize(input: {
    targetingKey: string;
    namespace: string;
    state: PseudonymousSubject["state"];
  }): PseudonymousSubject | Promise<PseudonymousSubject>;
  /** Rotation must produce a new revision without placing the old id in an event. */
  rotate(
    subject: PseudonymousSubject,
  ): PseudonymousSubject | Promise<PseudonymousSubject>;
  /** Linking anonymous and authenticated identities requires explicit application consent. */
  transition(input: {
    anonymous: PseudonymousSubject;
    authenticatedTargetingKey: string;
    consent: boolean;
  }): PseudonymousSubject | Promise<PseudonymousSubject>;
  erase(subject: PseudonymousSubject): void | Promise<void>;
  retentionUntil(event: FeatureEvent): string | undefined;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_DIMENSIONS = 16;
const MAX_DIMENSION_VALUE_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 96;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIMENSION_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PSEUDONYMOUS_SUBJECT_ID = /^psn_[A-Za-z0-9_-]{16,96}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const reasons = new Set<EvaluationReason>([
  "OFF",
  "TARGETING_MATCH",
  "SPLIT",
  "FALLTHROUGH",
  "PREREQUISITE_FAILED",
  "SCHEDULED_OUT",
  "DEFAULT",
]);
const platforms = new Set<FeatureEventSdk["platform"]>([
  "browser",
  "node",
  "react-native",
  "expo",
  "remote",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validName = (value: unknown, max = MAX_NAME_LENGTH): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function validateId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !EVENT_ID.test(value)
  ) {
    issues.push({
      path,
      message: `must be an opaque identifier of at most ${MAX_ID_LENGTH} characters`,
    });
    return false;
  }
  return true;
}

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

function validateSdk(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is FeatureEventSdk {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (!validName(value.name))
    issues.push({ path: `${path}.name`, message: "must be a bounded name" });
  if (!validName(value.version))
    issues.push({ path: `${path}.version`, message: "must be bounded" });
  if (!platforms.has(value.platform as FeatureEventSdk["platform"]))
    issues.push({ path: `${path}.platform`, message: "is not supported" });
  return true;
}

function validateSubject(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is PseudonymousSubject {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  validateId(value.id, `${path}.id`, issues);
  if (typeof value.id === "string" && !PSEUDONYMOUS_SUBJECT_ID.test(value.id))
    issues.push({
      path: `${path}.id`,
      message:
        "must use the psn_ prefix followed by a bounded opaque pseudonym",
    });
  if (!validName(value.namespace))
    issues.push({
      path: `${path}.namespace`,
      message: "must be a bounded application-scoped namespace",
    });
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    issues.push({
      path: `${path}.revision`,
      message: "must be a positive safe integer",
    });
  if (value.state !== "anonymous" && value.state !== "authenticated")
    issues.push({
      path: `${path}.state`,
      message: "must be anonymous or authenticated",
    });
  return true;
}

/** Runtime boundary for SDK-provided, application-keyed subject pseudonyms. */
export function parsePseudonymousSubjectId(
  value: unknown,
): PseudonymousSubjectId {
  if (typeof value !== "string" || !PSEUDONYMOUS_SUBJECT_ID.test(value)) {
    throw new TypeError(
      "Subject id must use the psn_ prefix followed by a bounded opaque pseudonym",
    );
  }
  return value as PseudonymousSubjectId;
}

function validateExperiment(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is ExperimentEventReference {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  validateId(value.experimentId, `${path}.experimentId`, issues);
  validateId(value.iterationId, `${path}.iterationId`, issues);
  return true;
}

function validateDimensions(
  value: unknown,
  allowed: ReadonlySet<string>,
  issues: ValidationIssue[],
): value is Readonly<Record<string, FeatureEventDimension>> {
  if (!isRecord(value)) {
    issues.push({ path: "$.dimensions", message: "must be an object" });
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DIMENSIONS)
    issues.push({
      path: "$.dimensions",
      message: `must contain at most ${MAX_DIMENSIONS} entries`,
    });
  for (const [key, dimension] of entries) {
    const path = `$.dimensions.${key}`;
    if (!allowed.has(key))
      issues.push({ path, message: "is not in the explicit allow-list" });
    if (!DIMENSION_KEY.test(key) || key.length > MAX_NAME_LENGTH)
      issues.push({ path, message: "has an invalid key" });
    if (
      !["string", "number", "boolean"].includes(typeof dimension) ||
      (typeof dimension === "number" && !Number.isFinite(dimension)) ||
      (typeof dimension === "string" &&
        dimension.length > MAX_DIMENSION_VALUE_LENGTH)
    )
      issues.push({ path, message: "must be a bounded scalar" });
  }
  return true;
}

/**
 * Validates and projects the canonical allow-listed envelope. Unknown fields are
 * ignored for forward compatibility; unsupported schema versions fail closed.
 */
export function validateFeatureEvent(
  input: unknown,
  options: FeatureEventParserOptions = {},
): ValidationResult<FeatureEvent> {
  const issues: ValidationIssue[] = [];
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return {
      success: false,
      issues: [{ path: "$", message: "must be JSON serializable" }],
    };
  }
  if (
    new TextEncoder().encode(encoded).byteLength >
    (options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)
  )
    return {
      success: false,
      issues: [{ path: "$", message: "payload exceeds the size limit" }],
    };
  if (!isRecord(input))
    return {
      success: false,
      issues: [{ path: "$", message: "must be an object" }],
    };
  if (input.schemaVersion !== FEATURE_EVENT_SCHEMA_VERSION)
    issues.push({ path: "$.schemaVersion", message: "must equal 1" });
  if (
    input.kind !== "decision" &&
    input.kind !== "assignment" &&
    input.kind !== "exposure" &&
    input.kind !== "outcome"
  )
    issues.push({ path: "$.kind", message: "is not supported" });
  validateId(input.id, "$.id", issues);
  validateSource(input.source, "$.source", issues);
  if (!validName(input.flagKey))
    issues.push({ path: "$.flagKey", message: "must be a bounded name" });
  if (!validName(input.variation))
    issues.push({ path: "$.variation", message: "must be a bounded name" });
  if (
    !Number.isSafeInteger(input.configVersion) ||
    (input.configVersion as number) < 0
  )
    issues.push({
      path: "$.configVersion",
      message: "must be a non-negative safe integer",
    });
  if (!reasons.has(input.reason as EvaluationReason))
    issues.push({ path: "$.reason", message: "is not supported" });
  if (
    typeof input.timestamp !== "string" ||
    !ISO_INSTANT.test(input.timestamp) ||
    !Number.isFinite(Date.parse(input.timestamp))
  )
    issues.push({
      path: "$.timestamp",
      message: "must be an ISO-8601 instant",
    });
  validateSdk(input.sdk, "$.sdk", issues);
  validateSubject(input.subject, "$.subject", issues);
  if (input.experiment !== undefined)
    validateExperiment(input.experiment, "$.experiment", issues);
  if (input.kind === "assignment" && input.experiment === undefined)
    issues.push({
      path: "$.experiment",
      message: "is required for assignment events",
    });
  if (input.dimensions !== undefined)
    validateDimensions(
      input.dimensions,
      new Set(options.allowedDimensions ?? []),
      issues,
    );
  if (input.kind === "outcome") {
    validateId(input.exposureId, "$.exposureId", issues);
    if (!isRecord(input.metric))
      issues.push({ path: "$.metric", message: "must be an object" });
    else {
      if (!validName(input.metric.key))
        issues.push({
          path: "$.metric.key",
          message: "must be a bounded name",
        });
      if (
        !Number.isSafeInteger(input.metric.revision) ||
        (input.metric.revision as number) < 1
      )
        issues.push({
          path: "$.metric.revision",
          message: "must be a positive safe integer",
        });
    }
    if (
      (typeof input.value !== "boolean" && typeof input.value !== "number") ||
      (typeof input.value === "number" && !Number.isFinite(input.value))
    )
      issues.push({ path: "$.value", message: "must be boolean or finite" });
  }
  if (issues.length > 0) return { success: false, issues };

  const common = {
    schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
    id: input.id as string,
    kind: input.kind as FeatureEventKind,
    source: {
      app: (input.source as Record<string, unknown>).app as string,
      environment: (input.source as Record<string, unknown>)
        .environment as string,
    },
    flagKey: input.flagKey as string,
    variation: input.variation as string,
    configVersion: input.configVersion as number,
    reason: input.reason as EvaluationReason,
    timestamp: input.timestamp as string,
    sdk: {
      name: (input.sdk as Record<string, unknown>).name as string,
      version: (input.sdk as Record<string, unknown>).version as string,
      platform: (input.sdk as Record<string, unknown>)
        .platform as FeatureEventSdk["platform"],
    },
    subject: {
      id: (input.subject as Record<string, unknown>)
        .id as PseudonymousSubjectId,
      namespace: (input.subject as Record<string, unknown>).namespace as string,
      revision: (input.subject as Record<string, unknown>).revision as number,
      state: (input.subject as Record<string, unknown>)
        .state as PseudonymousSubject["state"],
    },
    ...(input.experiment !== undefined
      ? {
          experiment: {
            experimentId: (input.experiment as Record<string, unknown>)
              .experimentId as string,
            iterationId: (input.experiment as Record<string, unknown>)
              .iterationId as string,
          },
        }
      : {}),
    ...(input.dimensions !== undefined
      ? {
          dimensions: Object.fromEntries(
            Object.entries(input.dimensions as Record<string, unknown>),
          ) as Record<string, FeatureEventDimension>,
        }
      : {}),
  };
  if (input.kind === "outcome") {
    const metric = input.metric as Record<string, unknown>;
    return {
      success: true,
      value: {
        ...common,
        kind: "outcome",
        exposureId: input.exposureId as string,
        metric: {
          key: metric.key as string,
          revision: metric.revision as number,
        },
        value: input.value as boolean | number,
      },
    };
  }
  return {
    success: true,
    value: {
      ...common,
      kind: input.kind,
    } as DecisionEvent | AssignmentEvent | ExposureEvent,
  };
}

export function parseFeatureEvent(
  input: unknown,
  options?: FeatureEventParserOptions,
): FeatureEvent {
  const result = validateFeatureEvent(input, options);
  if (result.success) return result.value;
  throw new TypeError(
    `Invalid feature event: ${result.issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("; ")}`,
  );
}

/** Creates an event without copying the evaluated value, context, or metadata. */
export function createEvaluationEvent(
  input: EvaluationEventInput,
): DecisionEvent | AssignmentEvent | ExposureEvent {
  if (!input.details.variation)
    throw new TypeError("An evaluated variation is required for an event");
  return parseFeatureEvent(
    {
      schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
      id: input.id,
      kind: input.kind,
      source: input.details.source,
      flagKey: input.details.flagKey,
      variation: input.details.variation,
      configVersion: input.details.configVersion,
      reason: input.details.reason,
      timestamp: input.details.timestamp,
      sdk: input.sdk,
      subject: input.subject,
      ...(input.experiment ? { experiment: input.experiment } : {}),
      ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    },
    input.allowedDimensions
      ? { allowedDimensions: input.allowedDimensions }
      : undefined,
  ) as DecisionEvent | AssignmentEvent | ExposureEvent;
}

function opaqueKey(prefix: string, parts: readonly JsonValue[]): string {
  const serialized = JSON.stringify(parts);
  const forward = stableHash(serialized).toString(16).padStart(8, "0");
  const reverse = stableHash([...serialized].reverse().join(""))
    .toString(16)
    .padStart(8, "0");
  return `${prefix}_${forward}${reverse}`;
}

/**
 * Exposure dedupe is once per app/environment, iteration (or config), subject
 * revision, flag, and variation. Event ids remain unique delivery identities.
 */
export function exposureDedupeKey(event: ExposureEvent): string {
  if (event.experiment)
    return opaqueKey("exposure", [
      event.source.app,
      event.source.environment,
      event.experiment.experimentId,
      event.experiment.iterationId,
      event.subject.namespace,
      event.subject.id,
      event.subject.revision,
    ]);
  return opaqueKey("exposure", [
    event.source.app,
    event.source.environment,
    event.configVersion,
    event.subject.namespace,
    event.subject.id,
    event.subject.revision,
    event.flagKey,
    event.variation,
  ]);
}

/** Outcome delivery may retry safely without counting a duplicate event id. */
export function featureEventDedupeKey(event: FeatureEvent): string {
  return opaqueKey("event", [
    event.source.app,
    event.source.environment,
    event.id,
  ]);
}
