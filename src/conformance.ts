import { createEvaluator } from "./evaluator";
import type {
  EvaluationContext,
  EvaluationReason,
  FlagConfig,
  FlagValue,
} from "./types";

export interface ConformanceVector {
  name: string;
  flagKey: string;
  context: EvaluationContext;
  fallback: FlagValue;
  now: string;
  expected: {
    value: FlagValue;
    source: { app: string; environment: string };
    configVersion: number;
    variation?: string;
    reason: EvaluationReason;
    ruleId?: string;
    segmentIds?: readonly string[];
  };
}

export const conformanceConfig = {
  schemaVersion: 1,
  source: { app: "conformance", environment: "test" },
  configVersion: 7,
  segments: {
    paid: {
      visibility: "client",
      rules: [
        {
          op: "match",
          attribute: "plan",
          operator: "in",
          value: ["pro", "team"],
        },
      ],
    },
  },
  flags: {
    entitlement: {
      type: "boolean",
      description: "Controls the prerequisite entitlement.",
      tags: ["conformance", "entitlement"],
      owner: "sdk-platform",
      lifecycle: "active",
      enabled: true,
      visibility: "client",
      variations: { denied: { value: false }, granted: { value: true } },
      offVariation: "denied",
      fallthrough: { variation: "granted" },
    },
    checkout: {
      type: "boolean",
      description: "Shows checkout to eligible paid users.",
      tags: ["conformance", "checkout"],
      owner: "growth",
      lifecycle: "active",
      enabled: true,
      visibility: "client",
      variations: { hidden: { value: false }, shown: { value: true } },
      offVariation: "hidden",
      prerequisites: [{ flag: "entitlement", variations: ["granted"] }],
      rules: [
        {
          id: "paid-users",
          when: { op: "segment", segment: "paid" },
          serve: { variation: "shown" },
        },
      ],
      fallthrough: { variation: "hidden" },
    },
    scheduled: {
      type: "string",
      description: "Exercises scheduled flag evaluation.",
      tags: ["conformance", "schedule"],
      owner: "sdk-platform",
      lifecycle: "draft",
      enabled: true,
      variations: { off: { value: "old" }, on: { value: "new" } },
      offVariation: "off",
      schedule: {
        start: "2030-01-01T00:00:00.000Z",
        end: "2031-01-01T00:00:00.000Z",
      },
      fallthrough: { variation: "on" },
    },
    progressive: {
      type: "string",
      description: "Exercises progressive rollout evaluation.",
      tags: ["conformance", "progressive"],
      owner: "sdk-platform",
      lifecycle: "active",
      enabled: true,
      variations: {
        control: { value: "control" },
        treatment: { value: "treatment" },
      },
      offVariation: "control",
      fallthrough: {
        progressive: {
          start: "2030-01-01T00:00:00.000Z",
          end: "2030-01-11T00:00:00.000Z",
          from: {
            variations: [{ variation: "control", weight: 100000 }],
            salt: "v1",
          },
          to: {
            variations: [{ variation: "treatment", weight: 100000 }],
            salt: "v1",
          },
        },
      },
    },
  },
} as const satisfies FlagConfig;

const expectedProvenance = {
  source: { app: "conformance", environment: "test" },
  configVersion: 7,
} as const;

export const conformanceVectors: readonly ConformanceVector[] = [
  {
    name: "segment targeting and prerequisite",
    flagKey: "checkout",
    context: { targetingKey: "user-1", attributes: { plan: "pro" } },
    fallback: false,
    now: "2029-01-01T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: true,
      variation: "shown",
      reason: "TARGETING_MATCH",
      ruleId: "paid-users",
      segmentIds: ["paid"],
    },
  },
  {
    name: "fallthrough outside segment",
    flagKey: "checkout",
    context: { targetingKey: "user-2", attributes: { plan: "free" } },
    fallback: true,
    now: "2029-01-01T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: false,
      variation: "hidden",
      reason: "FALLTHROUGH",
      segmentIds: [],
    },
  },
  {
    name: "schedule uses off variation before window",
    flagKey: "scheduled",
    context: { targetingKey: "user-3" },
    fallback: "fallback",
    now: "2029-01-01T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: "old",
      variation: "off",
      reason: "SCHEDULED_OUT",
      segmentIds: [],
    },
  },
  {
    name: "schedule serves fallthrough inside window",
    flagKey: "scheduled",
    context: { targetingKey: "user-3" },
    fallback: "fallback",
    now: "2030-06-01T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: "new",
      variation: "on",
      reason: "FALLTHROUGH",
      segmentIds: [],
    },
  },
  {
    name: "progressive rollout begins at source",
    flagKey: "progressive",
    context: { targetingKey: "user-4" },
    fallback: "fallback",
    now: "2030-01-01T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: "control",
      variation: "control",
      reason: "SPLIT",
      segmentIds: [],
    },
  },
  {
    name: "progressive rollout ends at destination",
    flagKey: "progressive",
    context: { targetingKey: "user-4" },
    fallback: "fallback",
    now: "2030-01-11T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: "treatment",
      variation: "treatment",
      reason: "SPLIT",
      segmentIds: [],
    },
  },
  {
    name: "progressive midpoint uses interpolated deterministic weights",
    flagKey: "progressive",
    context: { targetingKey: "user-2" },
    fallback: "fallback",
    now: "2030-01-06T00:00:00.000Z",
    expected: {
      ...expectedProvenance,
      value: "treatment",
      variation: "treatment",
      reason: "SPLIT",
      segmentIds: [],
    },
  },
] as const;

export interface ConformanceResult {
  name: string;
  pass: boolean;
  differences: readonly string[];
}

/** Reusable by every SDK to prove it matches the core semantics. */
export function runConformanceVectors(
  config: FlagConfig = conformanceConfig,
  vectors: readonly ConformanceVector[] = conformanceVectors,
): readonly ConformanceResult[] {
  const evaluator = createEvaluator(config);
  return vectors.map((vector) => {
    const actual = evaluator.evaluate(
      vector.flagKey,
      vector.context,
      vector.fallback,
      { now: vector.now },
    );
    const differences: string[] = [];
    for (const key of [
      "value",
      "source",
      "configVersion",
      "variation",
      "reason",
      "ruleId",
    ] as const) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(vector.expected[key]))
        differences.push(
          `${key}: expected ${JSON.stringify(vector.expected[key])}, received ${JSON.stringify(actual[key])}`,
        );
    }
    if (
      vector.expected.segmentIds &&
      JSON.stringify(actual.segmentIds) !==
        JSON.stringify(vector.expected.segmentIds)
    )
      differences.push(
        `segmentIds: expected ${JSON.stringify(vector.expected.segmentIds)}, received ${JSON.stringify(actual.segmentIds)}`,
      );
    return { name: vector.name, pass: differences.length === 0, differences };
  });
}
