import { parseConfig } from "./schema.js";
import type {
  AttributeValue,
  EvaluationContext,
  EvaluationDetails,
  EvaluationErrorCode,
  EvaluationOptions,
  EvaluationReason,
  Evaluator,
  Flag,
  FlagConfig,
  FlagKey,
  FlagValue,
  FlagValueFor,
  JsonValue,
  MatchOperator,
  PrerequisiteEvaluation,
  Rollout,
  Schedule,
  Segment,
  Serve,
  TargetingExpression,
} from "./types.js";

export const BUCKET_SIZE = 100_000;

export interface ServeSelection {
  variation?: string;
  bucket?: {
    value: number;
    size: typeof BUCKET_SIZE;
    bucketBy: string;
    salt: string;
    allocations: readonly {
      variation: string;
      start: number;
      end: number;
    }[];
  };
}

/** Stable FNV-1a hash. Kept explicit so every SDK can reproduce the same buckets. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function bucket(value: string): number {
  return stableHash(value) % BUCKET_SIZE;
}

function instant(options?: EvaluationOptions): Date {
  const raw = options?.now;
  return raw === undefined ? new Date() : new Date(raw);
}

function scheduleActive(schedule: Schedule | undefined, now: Date): boolean {
  if (!schedule) return true;
  const time = now.getTime();
  return (
    (schedule.start === undefined || time >= Date.parse(schedule.start)) &&
    (schedule.end === undefined || time < Date.parse(schedule.end))
  );
}

function readAttribute(
  context: EvaluationContext,
  attribute: string,
): AttributeValue | undefined {
  if (attribute === "targetingKey") return context.targetingKey;
  const path = attribute.startsWith("attributes.")
    ? attribute.slice(11)
    : attribute;
  let value: unknown = context.attributes;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value as AttributeValue | undefined;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  if (
    typeof left === "object" &&
    left !== null &&
    !Array.isArray(left) &&
    typeof right === "object" &&
    right !== null &&
    !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(([key, value]) => jsonEquals(value, rightRecord[key]))
    );
  }
  return false;
}

function compareVersions(left: string, right: string): number | undefined {
  const parse = (version: string) => {
    const match = version
      .trim()
      .match(
        /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
      );
    if (!match) return undefined;
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index++
  ) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : undefined;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : undefined;
    if (aNumber !== undefined && bNumber !== undefined)
      return Math.sign(aNumber - bNumber);
    if (aNumber !== undefined) return -1;
    if (bNumber !== undefined) return 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function matches(
  actual: AttributeValue | undefined,
  operator: MatchOperator,
  expected?: AttributeValue,
): boolean {
  if (operator === "exists") return actual !== undefined;
  if (actual === undefined) return false;
  if (operator === "eq") return jsonEquals(actual, expected);
  if (operator === "neq") return !jsonEquals(actual, expected);

  const actualValues = Array.isArray(actual) ? actual : [actual];
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  if (operator === "in")
    return actualValues.some((entry) =>
      expectedValues.some((candidate) => jsonEquals(entry, candidate)),
    );
  if (operator === "notIn")
    return actualValues.every((entry) =>
      expectedValues.every((candidate) => !jsonEquals(entry, candidate)),
    );

  if (typeof actual !== "string" || typeof expected !== "string") {
    if (
      ["gt", "gte", "lt", "lte"].includes(operator) &&
      typeof actual === "number" &&
      typeof expected === "number"
    ) {
      if (operator === "gt") return actual > expected;
      if (operator === "gte") return actual >= expected;
      if (operator === "lt") return actual < expected;
      return actual <= expected;
    }
    return false;
  }
  if (operator === "contains") return actual.includes(expected);
  if (operator === "startsWith") return actual.startsWith(expected);
  if (operator === "endsWith") return actual.endsWith(expected);
  if (operator === "matches") {
    try {
      return new RegExp(expected, "u").test(actual);
    } catch {
      return false;
    }
  }
  if (operator === "before" || operator === "after") {
    const left = Date.parse(actual);
    const right = Date.parse(expected);
    return (
      Number.isFinite(left) &&
      Number.isFinite(right) &&
      (operator === "before" ? left < right : left > right)
    );
  }
  const comparison = compareVersions(actual, expected);
  if (comparison === undefined) return false;
  if (operator === "semverEq") return comparison === 0;
  if (operator === "semverGt") return comparison > 0;
  if (operator === "semverGte") return comparison >= 0;
  if (operator === "semverLt") return comparison < 0;
  if (operator === "semverLte") return comparison <= 0;
  return false;
}

function interpolateRollout(
  serve: Extract<Serve, { progressive: unknown }>,
  now: Date,
): Rollout {
  const { progressive } = serve;
  const start = Date.parse(progressive.start);
  const end = Date.parse(progressive.end);
  const progress = Math.max(
    0,
    Math.min(1, (now.getTime() - start) / (end - start)),
  );
  const from = new Map(
    progressive.from.variations.map((item) => [item.variation, item.weight]),
  );
  const to = new Map(
    progressive.to.variations.map((item) => [item.variation, item.weight]),
  );
  const ids = [...new Set([...from.keys(), ...to.keys()])];
  return {
    variations: ids.map((variation) => ({
      variation,
      weight: Math.round(
        (from.get(variation) ?? 0) +
          ((to.get(variation) ?? 0) - (from.get(variation) ?? 0)) * progress,
      ),
    })),
    ...((progressive.to.bucketBy ?? progressive.from.bucketBy) !== undefined
      ? { bucketBy: progressive.to.bucketBy ?? progressive.from.bucketBy }
      : {}),
    ...((progressive.to.salt ?? progressive.from.salt) !== undefined
      ? { salt: progressive.to.salt ?? progressive.from.salt }
      : {}),
  };
}

function valueKind(
  value: JsonValue,
): "boolean" | "string" | "number" | "object" {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "object";
}

/** Shared serve-selection primitive used by evaluation and deterministic inspection. */
export function selectServe(
  serve: Serve,
  flagKey: string,
  context: EvaluationContext,
  now: Date,
): ServeSelection {
  if ("variation" in serve) return { variation: serve.variation };
  const rollout =
    "rollout" in serve ? serve.rollout : interpolateRollout(serve, now);
  const bucketBy = rollout.bucketBy ?? "targetingKey";
  const bucketValue = readAttribute(context, bucketBy);
  if (
    bucketValue === undefined ||
    (typeof bucketValue !== "string" && typeof bucketValue !== "number")
  )
    return {};
  const salt = rollout.salt ?? "";
  const allocationBucket = bucket(`${flagKey}:${salt}:${String(bucketValue)}`);
  let cursor = 0;
  const allocations = rollout.variations.map((allocation) => {
    const start = cursor;
    cursor += allocation.weight;
    return { variation: allocation.variation, start, end: cursor };
  });
  const variation = allocations.find(
    (allocation) => allocationBucket < allocation.end,
  )?.variation;
  return {
    ...(variation !== undefined ? { variation } : {}),
    bucket: {
      value: allocationBucket,
      size: BUCKET_SIZE,
      bucketBy,
      salt,
      allocations,
    },
  };
}

interface InternalResult {
  variation?: string | undefined;
  reason: EvaluationReason;
  ruleId?: string | undefined;
  segmentIds: Set<string>;
  prerequisites: PrerequisiteEvaluation[];
  errorCode?: EvaluationErrorCode | undefined;
  errorMessage?: string | undefined;
}

export function createEvaluator<const C extends FlagConfig>(
  input: C,
): Evaluator<C> {
  const config = parseConfig(input) as C;

  function segmentMatch(
    segmentId: string,
    context: EvaluationContext,
    now: Date,
    visited: Set<string>,
    matched: Set<string>,
  ): boolean {
    if (visited.has(segmentId)) return false;
    const segment = config.segments?.[segmentId] as Segment | undefined;
    if (!segment || !scheduleActive(segment.schedule, now)) return false;
    const nextVisited = new Set(visited).add(segmentId);
    if (segment.excluded?.includes(context.targetingKey)) return false;
    const result =
      segment.included?.includes(context.targetingKey) ||
      segment.rules?.some((rule) =>
        expressionMatch(rule, context, now, nextVisited, matched),
      ) ||
      false;
    if (result) matched.add(segmentId);
    return result;
  }

  function expressionMatch(
    expression: TargetingExpression,
    context: EvaluationContext,
    now: Date,
    visitedSegments: Set<string>,
    matchedSegments: Set<string>,
  ): boolean {
    if (expression.op === "all")
      return expression.expressions.every((entry) =>
        expressionMatch(entry, context, now, visitedSegments, matchedSegments),
      );
    if (expression.op === "any")
      return expression.expressions.some((entry) =>
        expressionMatch(entry, context, now, visitedSegments, matchedSegments),
      );
    if (expression.op === "not")
      return !expressionMatch(
        expression.expression,
        context,
        now,
        visitedSegments,
        matchedSegments,
      );
    if (expression.op === "segment") {
      const result = segmentMatch(
        expression.segment,
        context,
        now,
        visitedSegments,
        matchedSegments,
      );
      return expression.negate ? !result : result;
    }
    return matches(
      readAttribute(context, expression.attribute),
      expression.operator,
      expression.value,
    );
  }

  function offResult(
    flag: Flag,
    reason: EvaluationReason,
    extras: Partial<InternalResult> = {},
  ): InternalResult {
    return {
      variation: flag.offVariation,
      reason,
      segmentIds: new Set(),
      prerequisites: [],
      ...extras,
    };
  }

  function evaluateInternal(
    flagKey: string,
    context: EvaluationContext,
    now: Date,
    stack: readonly string[],
  ): InternalResult {
    const flag = config.flags[flagKey] as Flag | undefined;
    if (!flag)
      return {
        reason: "DEFAULT",
        segmentIds: new Set(),
        prerequisites: [],
        errorCode: "FLAG_NOT_FOUND",
        errorMessage: `Flag ${flagKey} was not found`,
      };
    if (stack.includes(flagKey))
      return offResult(flag, "DEFAULT", {
        errorCode: "CYCLE_DETECTED",
        errorMessage: `Prerequisite cycle: ${[...stack, flagKey].join(" -> ")}`,
      });
    if (!flag.enabled) return offResult(flag, "OFF");
    if (!scheduleActive(flag.schedule, now))
      return offResult(flag, "SCHEDULED_OUT");

    const prerequisiteEvaluations: PrerequisiteEvaluation[] = [];
    for (const prerequisite of flag.prerequisites ?? []) {
      const dependency = evaluateInternal(prerequisite.flag, context, now, [
        ...stack,
        flagKey,
      ]);
      const satisfied =
        dependency.variation !== undefined &&
        prerequisite.variations.includes(dependency.variation) &&
        dependency.errorCode === undefined;
      prerequisiteEvaluations.push({
        flagKey: prerequisite.flag,
        variation: dependency.variation,
        satisfied,
        reason: dependency.reason,
      });
      if (!satisfied) {
        const cycle = dependency.errorCode === "CYCLE_DETECTED";
        return offResult(flag, "PREREQUISITE_FAILED", {
          prerequisites: prerequisiteEvaluations,
          ...(cycle
            ? {
                errorCode: "CYCLE_DETECTED",
                errorMessage: dependency.errorMessage,
              }
            : {}),
        });
      }
    }

    for (const rule of flag.rules ?? []) {
      if (!scheduleActive(rule.schedule, now)) continue;
      const segments = new Set<string>();
      if (!expressionMatch(rule.when, context, now, new Set(), segments))
        continue;
      const variation = selectServe(
        rule.serve,
        flagKey,
        context,
        now,
      ).variation;
      if (variation !== undefined)
        return {
          variation,
          reason:
            "rollout" in rule.serve || "progressive" in rule.serve
              ? "SPLIT"
              : "TARGETING_MATCH",
          ruleId: rule.id,
          segmentIds: segments,
          prerequisites: prerequisiteEvaluations,
        };
    }
    const variation = selectServe(
      flag.fallthrough,
      flagKey,
      context,
      now,
    ).variation;
    return {
      variation,
      reason:
        "rollout" in flag.fallthrough || "progressive" in flag.fallthrough
          ? "SPLIT"
          : "FALLTHROUGH",
      segmentIds: new Set(),
      prerequisites: prerequisiteEvaluations,
    };
  }

  function details<T extends JsonValue>(
    flagKey: string,
    context: EvaluationContext,
    fallback: T,
    expectedKind: ReturnType<typeof valueKind>,
    options?: EvaluationOptions,
  ): EvaluationDetails<T> {
    const now = instant(options);
    const validNow = Number.isFinite(now.getTime());
    const base = {
      flagKey,
      source: config.source,
      configVersion: config.configVersion,
      segmentIds: [] as string[],
      prerequisites: [] as PrerequisiteEvaluation[],
      timestamp: validNow ? now.toISOString() : new Date().toISOString(),
    };
    if (!validNow)
      return {
        ...base,
        value: fallback,
        reason: "DEFAULT",
        errorCode: "EVALUATION_ERROR",
        errorMessage: "options.now is invalid",
      };
    if (
      !context ||
      typeof context.targetingKey !== "string" ||
      context.targetingKey.length === 0
    )
      return {
        ...base,
        value: fallback,
        reason: "DEFAULT",
        errorCode: "INVALID_CONTEXT",
        errorMessage: "targetingKey must be a non-empty string",
      };

    try {
      const result = evaluateInternal(flagKey, context, now, []);
      const flag = config.flags[flagKey] as Flag | undefined;
      const variation =
        flag && result.variation
          ? flag.variations[result.variation]
          : undefined;
      if (!flag || !variation || result.errorCode)
        return {
          ...base,
          value: fallback,
          reason: result.reason,
          variation: result.variation,
          segmentIds: [...result.segmentIds].sort(),
          prerequisites: result.prerequisites,
          errorCode: result.errorCode ?? "EVALUATION_ERROR",
          errorMessage: result.errorMessage ?? "No variation was selected",
          metadata: flag?.metadata,
        };
      if (valueKind(variation.value) !== expectedKind)
        return {
          ...base,
          value: fallback,
          variation: result.variation,
          reason: "DEFAULT",
          segmentIds: [...result.segmentIds].sort(),
          prerequisites: result.prerequisites,
          errorCode: "TYPE_MISMATCH",
          errorMessage: `Flag ${flagKey} is ${valueKind(variation.value)}, not ${expectedKind}`,
          metadata: flag.metadata,
        };
      return {
        ...base,
        value: variation.value as T,
        variation: result.variation,
        reason: result.reason,
        ruleId: result.ruleId,
        segmentIds: [...result.segmentIds].sort(),
        prerequisites: result.prerequisites,
        metadata: flag.metadata,
      };
    } catch (error) {
      return {
        ...base,
        value: fallback,
        reason: "DEFAULT",
        errorCode: "EVALUATION_ERROR",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    evaluate<K extends FlagKey<C>>(
      flagKey: K,
      context: EvaluationContext,
      fallback: FlagValueFor<C, K>,
      options?: EvaluationOptions,
    ) {
      return details(flagKey, context, fallback, valueKind(fallback), options);
    },
    boolean(flagKey, context, fallback, options) {
      return details(flagKey, context, fallback, "boolean", options);
    },
    string(flagKey, context, fallback, options) {
      return details(flagKey, context, fallback, "string", options);
    },
    number(flagKey, context, fallback, options) {
      return details(flagKey, context, fallback, "number", options);
    },
    object<T extends JsonValue>(
      flagKey: FlagKey<C>,
      context: EvaluationContext,
      fallback: T,
      options?: EvaluationOptions,
    ) {
      return details(flagKey, context, fallback, "object", options);
    },
  };
}
