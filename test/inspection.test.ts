import { describe, expect, test } from "bun:test";
import {
  bucket,
  createEvaluator,
  dependencyPaths,
  type Evaluator,
  explainEvaluation,
  type FlagConfig,
  impactPaths,
  simulateProposedConfig,
  testSegmentMembership,
} from "../src";
import { conformanceConfig, conformanceVectors } from "../src/conformance";

describe("deterministic inspection", () => {
  test("golden explanation exposes ordered stages and bucket details", () => {
    const explanation = explainEvaluation(
      conformanceConfig,
      "progressive",
      { targetingKey: "user-4" },
      "fallback",
      "2030-01-01T00:00:00.000Z",
    );
    expect(explanation).toEqual({
      schemaVersion: 1,
      source: { app: "conformance", environment: "test" },
      configVersion: 7,
      flagKey: "progressive",
      now: "2030-01-01T00:00:00.000Z",
      stages: [
        {
          stage: "eligibility",
          eligible: true,
          reason: "SPLIT",
          prerequisites: [],
        },
        {
          stage: "assignment",
          attempted: true,
          serve: "progressive",
          variation: "control",
          progressiveSchedule: {
            start: "2030-01-01T00:00:00.000Z",
            end: "2030-01-11T00:00:00.000Z",
          },
          bucket: {
            value: bucket("progressive:v1:user-4"),
            size: 100_000,
            bucketBy: "targetingKey",
            salt: "v1",
            allocations: [
              { variation: "control", start: 0, end: 100_000 },
              { variation: "treatment", start: 100_000, end: 100_000 },
            ],
          },
        },
        {
          stage: "evaluation",
          details: {
            flagKey: "progressive",
            source: { app: "conformance", environment: "test" },
            configVersion: 7,
            value: "control",
            variation: "control",
            reason: "SPLIT",
            segmentIds: [],
            prerequisites: [],
            timestamp: "2030-01-01T00:00:00.000Z",
          },
        },
        {
          stage: "exposure-candidate",
          candidate: true,
          flagKey: "progressive",
          variation: "control",
          configVersion: 7,
          reason: "SPLIT",
        },
      ],
    });
  });

  test("explanations preserve evaluator conformance exactly", () => {
    const evaluator = createEvaluator(
      conformanceConfig,
    ) as Evaluator<FlagConfig>;
    for (const vector of conformanceVectors) {
      const direct = evaluator.evaluate(
        vector.flagKey,
        vector.context,
        vector.fallback,
        { now: vector.now },
      );
      const explanation = explainEvaluation(
        conformanceConfig,
        vector.flagKey,
        vector.context,
        vector.fallback,
        vector.now,
      );
      expect(explanation.stages[2].details).toEqual(direct);
    }
  });

  test("segment membership delegates to evaluator semantics", () => {
    expect(
      testSegmentMembership(
        conformanceConfig,
        "paid",
        { targetingKey: "pro", attributes: { plan: "pro" } },
        "2029-01-01T00:00:00.000Z",
      ),
    ).toEqual({
      segmentId: "paid",
      matched: true,
      now: "2029-01-01T00:00:00.000Z",
      segmentIds: ["paid"],
    });
    expect(
      testSegmentMembership(
        conformanceConfig,
        "paid",
        { targetingKey: "free", attributes: { plan: "free" } },
        "2029-01-01T00:00:00.000Z",
      ).matched,
    ).toBe(false);
    expect(
      testSegmentMembership(
        conformanceConfig,
        "missing",
        { targetingKey: "user" },
        "2029-01-01T00:00:00.000Z",
      ).error,
    ).toBe("SEGMENT_NOT_FOUND");
  });

  test("dependency and reverse impact paths are deterministic", () => {
    expect(
      dependencyPaths(conformanceConfig, { kind: "flag", key: "checkout" }),
    ).toEqual([
      {
        resources: [
          { kind: "flag", key: "checkout" },
          { kind: "flag", key: "entitlement" },
        ],
        relationships: ["flag_prerequisite"],
      },
      {
        resources: [
          { kind: "flag", key: "checkout" },
          { kind: "segment", key: "paid" },
        ],
        relationships: ["flag_segment"],
      },
    ]);
    expect(
      impactPaths(conformanceConfig, { kind: "segment", key: "paid" }),
    ).toEqual([
      {
        resources: [
          { kind: "segment", key: "paid" },
          { kind: "flag", key: "checkout" },
        ],
        relationships: ["flag_segment"],
      },
    ]);
  });

  test("proposed-config simulation has direct evaluator parity", () => {
    const proposed = structuredClone(conformanceConfig) as FlagConfig;
    const checkout = proposed.flags.checkout;
    if (!checkout) throw new Error("checkout fixture is required");
    checkout.fallthrough = { variation: "shown" };
    proposed.configVersion = 8;
    const scenario = {
      id: "free-checkout",
      flagKey: "checkout",
      context: { targetingKey: "free", attributes: { plan: "free" } },
      fallback: false,
      now: "2029-01-01T00:00:00.000Z",
    } as const;
    const [simulation] = simulateProposedConfig(conformanceConfig, proposed, [
      scenario,
    ]);
    const direct = createEvaluator(proposed).boolean(
      "checkout",
      scenario.context,
      false,
      { now: scenario.now },
    );
    expect(simulation?.changed).toBe(true);
    expect(simulation?.after.stages[2].details).toEqual(direct);
    expect(simulation?.before.stages[2].details.value).toBe(false);
    expect(simulation?.after.stages[2].details.value).toBe(true);
  });

  test("property sweep remains deterministic and bucket-bounded", () => {
    for (let index = 0; index < 256; index++) {
      const context = { targetingKey: `subject-${index}` };
      const first = explainEvaluation(
        conformanceConfig,
        "progressive",
        context,
        "fallback",
        "2030-01-06T00:00:00.000Z",
      );
      const second = explainEvaluation(
        conformanceConfig,
        "progressive",
        context,
        "fallback",
        "2030-01-06T00:00:00.000Z",
      );
      expect(second).toEqual(first);
      const bucketDetails = first.stages[1].bucket;
      expect(bucketDetails?.value).toBeGreaterThanOrEqual(0);
      expect(bucketDetails?.value).toBeLessThan(100_000);
      expect(first.stages[2].details).toEqual(
        createEvaluator(conformanceConfig).string(
          "progressive",
          context,
          "fallback",
          { now: "2030-01-06T00:00:00.000Z" },
        ),
      );
    }
  });

  test("inspection rejects implicit or invalid time", () => {
    expect(() =>
      explainEvaluation(
        conformanceConfig,
        "checkout",
        { targetingKey: "user" },
        false,
        "not-a-time",
      ),
    ).toThrow("valid explicit instant");
  });
});
