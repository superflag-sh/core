import { createEvaluator } from "./evaluator.js";
import {
  type FeatureEvent,
  type FeatureEventParserOptions,
  parseFeatureEvent,
} from "./events.js";
import { assignExperiment, type ExperimentIteration } from "./experiments.js";
import type {
  EvaluationContext,
  EvaluationReason,
  FlagConfig,
  FlagValue,
} from "./types.js";

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

export const experimentConformanceConfig = {
  schemaVersion: 1,
  source: { app: "conformance", environment: "experiment" },
  configVersion: 11,
  flags: {
    checkout: {
      type: "string",
      description: "Canonical A/B assignment flag.",
      tags: ["conformance", "experiment"],
      owner: "sdk-platform",
      lifecycle: "active",
      enabled: true,
      variations: {
        control: { value: "control" },
        treatment: { value: "treatment" },
      },
      offVariation: "control",
      fallthrough: { variation: "control" },
    },
  },
} as const satisfies FlagConfig;

export const experimentConformanceIteration = {
  schemaVersion: 1,
  id: "checkout-iteration-1",
  experimentId: "checkout-experiment",
  number: 1,
  source: experimentConformanceConfig.source,
  flagKey: "checkout",
  configVersion: experimentConformanceConfig.configVersion,
  variations: ["control", "treatment"],
  allocation: [
    { variation: "control", weight: 50_000 },
    { variation: "treatment", weight: 50_000 },
  ],
  salt: "exp-v1",
  assignmentUnit: { kind: "targetingKey" },
  audience: { kind: "all", id: "all", version: 1 },
  primaryMetric: { key: "checkout-completed", revision: 1 },
  secondaryMetrics: [],
  guardrailMetrics: [{ key: "checkout-error", revision: 2 }],
  startedAt: "2030-01-01T00:00:00.000Z",
} as const satisfies ExperimentIteration;

export const experimentConformanceVectors = [
  { targetingKey: "user-1", expectedVariation: "control" },
  { targetingKey: "user-2", expectedVariation: "treatment" },
  { targetingKey: "user-5", expectedVariation: "control" },
] as const;

export function runExperimentConformanceVectors(): readonly ConformanceResult[] {
  return experimentConformanceVectors.map((vector) => {
    const assignment = assignExperiment(
      experimentConformanceIteration,
      experimentConformanceConfig,
      { targetingKey: vector.targetingKey },
    );
    const differences =
      assignment.variation === vector.expectedVariation
        ? []
        : [
            `variation: expected ${vector.expectedVariation}, received ${String(assignment.variation)}`,
          ];
    return {
      name: `experiment assignment for ${vector.targetingKey}`,
      pass: differences.length === 0,
      differences,
    };
  });
}

export const experimentAbnConformanceConfig = {
  ...experimentConformanceConfig,
  flags: {
    checkout: {
      ...experimentConformanceConfig.flags.checkout,
      description: "Canonical A/B/n assignment flag.",
      variations: {
        control: { value: "control" },
        treatment: { value: "treatment" },
        holdout: { value: "holdout" },
      },
    },
  },
} as const satisfies FlagConfig;

export const experimentAbnConformanceIteration = {
  ...experimentConformanceIteration,
  id: "checkout-abn-iteration-1",
  variations: ["control", "treatment", "holdout"],
  allocation: [
    { variation: "control", weight: 25_000 },
    { variation: "treatment", weight: 35_000 },
    { variation: "holdout", weight: 40_000 },
  ],
  salt: "abn-v1",
} as const satisfies ExperimentIteration;

export interface ExperimentAssignmentConformanceVector {
  name: string;
  iteration: ExperimentIteration;
  context: EvaluationContext;
  expected: {
    variation?: string;
    eligible: boolean;
    reason: EvaluationReason;
  };
}

const attributeExperimentIteration = {
  ...experimentAbnConformanceIteration,
  id: "checkout-attribute-iteration-1",
  assignmentUnit: { kind: "attribute", attribute: "account.id" },
} as const satisfies ExperimentIteration;

export const experimentAssignmentConformanceVectors: readonly ExperimentAssignmentConformanceVector[] =
  [
    {
      name: "A/B/n first bucket boundary",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-159033" },
      expected: { variation: "control", eligible: true, reason: "SPLIT" },
    },
    {
      name: "A/B/n last control bucket",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-17758" },
      expected: { variation: "control", eligible: true, reason: "SPLIT" },
    },
    {
      name: "A/B/n first treatment bucket",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-31315" },
      expected: { variation: "treatment", eligible: true, reason: "SPLIT" },
    },
    {
      name: "A/B/n last treatment bucket",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-80022" },
      expected: { variation: "treatment", eligible: true, reason: "SPLIT" },
    },
    {
      name: "A/B/n first holdout bucket",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-31597" },
      expected: { variation: "holdout", eligible: true, reason: "SPLIT" },
    },
    {
      name: "A/B/n final bucket boundary",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "boundary-11657" },
      expected: { variation: "holdout", eligible: true, reason: "SPLIT" },
    },
    {
      name: "Unicode targeting key",
      iteration: experimentAbnConformanceIteration,
      context: { targetingKey: "用户-🚀-é" },
      expected: { variation: "holdout", eligible: true, reason: "SPLIT" },
    },
    {
      name: "nested Unicode attribute assignment",
      iteration: attributeExperimentIteration,
      context: {
        targetingKey: "subject-does-not-control-assignment",
        attributes: { account: { id: "组织-🚀" } },
      },
      expected: { variation: "treatment", eligible: true, reason: "SPLIT" },
    },
    {
      name: "missing assignment attribute is ineligible",
      iteration: attributeExperimentIteration,
      context: { targetingKey: "missing-account" },
      expected: { eligible: false, reason: "SPLIT" },
    },
  ] as const;

export function runExperimentAssignmentConformanceVectors(): readonly ConformanceResult[] {
  return experimentAssignmentConformanceVectors.map((vector) => {
    const assignment = assignExperiment(
      vector.iteration,
      experimentAbnConformanceConfig,
      vector.context,
    );
    const differences = Object.entries(vector.expected).flatMap(
      ([key, expected]) => {
        const actual = assignment[key as keyof typeof assignment];
        return actual === expected
          ? []
          : [
              `${key}: expected ${String(expected)}, received ${String(actual)}`,
            ];
      },
    );
    return {
      name: vector.name,
      pass: differences.length === 0,
      differences,
    };
  });
}

export interface FeatureEventConformanceVector {
  name: string;
  input: unknown;
  expected: FeatureEvent;
  options?: FeatureEventParserOptions;
}

const eventBase = {
  schemaVersion: 1,
  source: { app: "conformance", environment: "experiment" },
  flagKey: "checkout",
  variation: "treatment",
  configVersion: 11,
  reason: "SPLIT",
  timestamp: "2030-01-01T00:00:01.000Z",
  subject: {
    id: "psn_7fcc043e7fcc043e",
    namespace: "conformance",
    revision: 1,
    state: "authenticated",
  },
  experiment: {
    experimentId: "checkout-experiment",
    iterationId: "checkout-iteration-1",
  },
} as const;

export const featureEventConformanceVectors: readonly FeatureEventConformanceVector[] =
  [
    {
      name: "browser decision envelope",
      input: {
        ...eventBase,
        id: "evt-browser-1",
        kind: "decision",
        sdk: {
          name: "@superflag-sh/react",
          version: "1.0.0",
          platform: "browser",
        },
        targetingKey: "must-not-survive",
        clientKey: "must-not-survive",
        value: { private: "must-not-survive" },
      },
      expected: {
        ...eventBase,
        id: "evt-browser-1",
        kind: "decision",
        sdk: {
          name: "@superflag-sh/react",
          version: "1.0.0",
          platform: "browser",
        },
      },
    },
    {
      name: "React Native exposure envelope",
      input: {
        ...eventBase,
        id: "evt-rn-1",
        kind: "exposure",
        sdk: {
          name: "@superflag-sh/react-native",
          version: "1.0.0",
          platform: "react-native",
        },
        context: { email: "must-not-survive@example.com" },
      },
      expected: {
        ...eventBase,
        id: "evt-rn-1",
        kind: "exposure",
        sdk: {
          name: "@superflag-sh/react-native",
          version: "1.0.0",
          platform: "react-native",
        },
      },
    },
    {
      name: "Node assignment envelope",
      input: {
        ...eventBase,
        id: "evt-node-1",
        kind: "assignment",
        sdk: { name: "@superflag-sh/node", version: "1.0.0", platform: "node" },
        attributes: { plan: "must-not-survive" },
      },
      expected: {
        ...eventBase,
        id: "evt-node-1",
        kind: "assignment",
        sdk: { name: "@superflag-sh/node", version: "1.0.0", platform: "node" },
      },
    },
  ] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function runFeatureEventConformanceVectors(): readonly ConformanceResult[] {
  return featureEventConformanceVectors.map((vector) => {
    const actual = parseFeatureEvent(vector.input, vector.options);
    const differences =
      canonicalJson(actual) === canonicalJson(vector.expected)
        ? []
        : [
            `event: expected ${JSON.stringify(vector.expected)}, received ${JSON.stringify(actual)}`,
          ];
    return { name: vector.name, pass: differences.length === 0, differences };
  });
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
