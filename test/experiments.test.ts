import { describe, expect, test } from "bun:test";
import {
  experimentAbnConformanceConfig,
  experimentAbnConformanceIteration,
  experimentAssignmentConformanceVectors,
  experimentConformanceConfig,
  experimentConformanceIteration,
  runExperimentAssignmentConformanceVectors,
  runExperimentConformanceVectors,
} from "../src/conformance";
import { bucket } from "../src/evaluator";
import {
  assignExperiment,
  type Experiment,
  type ExperimentIteration,
  isAssignmentPreservingRamp,
  parseExperimentIteration,
  validateExperiment,
  validateExperimentIteration,
  validateExperimentLifecycleTransition,
  validateIterationReplacement,
} from "../src/experiments";

describe("experiment contracts", () => {
  test("validates the complete lifecycle record", () => {
    const experiment = {
      schemaVersion: 1,
      id: "checkout-experiment",
      source: experimentConformanceConfig.source,
      lifecycle: "draft",
      hypothesis: "The new checkout increases completed orders.",
      owner: "growth",
      flagKey: "checkout",
      audience: { kind: "all" },
      assignmentUnit: { kind: "targetingKey" },
      primaryMetric: { key: "checkout-completed", revision: 1 },
      secondaryMetrics: [{ key: "revenue", revision: 2 }],
      guardrailMetrics: [{ key: "checkout-error", revision: 2 }],
      intendedDurationDays: 14,
      sampleTarget: 10_000,
    } as const satisfies Experiment;
    expect(validateExperiment(experiment)).toEqual({
      success: true,
      value: experiment,
    });
    for (const lifecycle of [
      "draft",
      "running",
      "paused",
      "completed",
      "archived",
    ] as const)
      expect(
        validateExperiment({ ...experiment, lifecycle }).success,
      ).toBeTrue();
  });

  test("enforces the explicit lifecycle transition graph", () => {
    const allowed = new Set([
      "draft:running",
      "draft:archived",
      "running:paused",
      "running:completed",
      "paused:running",
      "paused:completed",
      "completed:archived",
    ]);
    const lifecycles = [
      "draft",
      "running",
      "paused",
      "completed",
      "archived",
    ] as const;
    for (const previous of lifecycles) {
      for (const next of lifecycles) {
        expect(
          validateExperimentLifecycleTransition(previous, next).success,
        ).toBe(allowed.has(`${previous}:${next}`));
      }
    }
  });

  test("rejects a metric revision reused across experiment roles", () => {
    const duplicateMetric = { key: "checkout-completed", revision: 1 };
    const experiment = {
      schemaVersion: 1,
      id: "checkout-experiment",
      source: experimentConformanceConfig.source,
      lifecycle: "draft",
      hypothesis: "The new checkout increases completed orders.",
      owner: "growth",
      flagKey: "checkout",
      audience: { kind: "all" },
      assignmentUnit: { kind: "targetingKey" },
      primaryMetric: duplicateMetric,
      secondaryMetrics: [duplicateMetric],
      guardrailMetrics: [duplicateMetric],
      intendedDurationDays: 14,
      sampleTarget: 10_000,
    } as const satisfies Experiment;
    const experimentResult = validateExperiment(experiment);
    expect(experimentResult.success).toBeFalse();
    if (!experimentResult.success) {
      expect(experimentResult.issues.map((issue) => issue.path)).toContain(
        "$.secondaryMetrics[0]",
      );
      expect(experimentResult.issues.map((issue) => issue.path)).toContain(
        "$.guardrailMetrics[0]",
      );
    }

    const iterationResult = validateExperimentIteration({
      ...experimentConformanceIteration,
      secondaryMetrics: [duplicateMetric],
    });
    expect(iterationResult.success).toBeFalse();
    if (!iterationResult.success)
      expect(iterationResult.issues.map((issue) => issue.path)).toContain(
        "$.secondaryMetrics[0]",
      );
  });

  test("parses a recursively immutable, reproducible iteration snapshot", () => {
    const iteration = parseExperimentIteration(experimentConformanceIteration);
    expect(Object.isFrozen(iteration)).toBeTrue();
    expect(Object.isFrozen(iteration.allocation)).toBeTrue();
    expect(Object.isFrozen(iteration.primaryMetric)).toBeTrue();
    expect(iteration).toMatchObject({
      configVersion: 11,
      variations: ["control", "treatment"],
      salt: "exp-v1",
      primaryMetric: { key: "checkout-completed", revision: 1 },
    });
  });

  test("golden A/B and A/B/n vectors are deterministic across runtimes", () => {
    expect(
      runExperimentConformanceVectors().every((result) => result.pass),
    ).toBeTrue();
    expect(
      runExperimentAssignmentConformanceVectors().every(
        (result) => result.pass,
      ),
    ).toBeTrue();
    expect(
      experimentAssignmentConformanceVectors
        .slice(0, 6)
        .map((vector) =>
          bucket(`checkout:abn-v1:${String(vector.context.targetingKey)}`),
        ),
    ).toEqual([0, 24_999, 25_000, 59_999, 60_000, 99_999]);
    for (let index = 0; index < 100; index++) {
      const context = { targetingKey: `stable-${index}` };
      expect(
        assignExperiment(
          experimentConformanceIteration,
          experimentConformanceConfig,
          context,
        ),
      ).toEqual(
        assignExperiment(
          experimentConformanceIteration,
          experimentConformanceConfig,
          context,
        ),
      );
    }
  });

  test("distribution remains close to the pinned allocation", () => {
    const counts = { control: 0, treatment: 0 };
    for (let index = 0; index < 20_000; index++) {
      const assignment = assignExperiment(
        experimentConformanceIteration,
        experimentConformanceConfig,
        { targetingKey: `distribution-${index}` },
      );
      if (assignment.variation === "control") counts.control++;
      if (assignment.variation === "treatment") counts.treatment++;
    }
    expect(counts.control).toBeGreaterThan(9_600);
    expect(counts.control).toBeLessThan(10_400);
    expect(counts.treatment).toBe(20_000 - counts.control);
  });

  test("an inline audience snapshot gates assignment through the evaluator", () => {
    const iteration = {
      ...experimentConformanceIteration,
      audience: {
        kind: "expression",
        id: "paid-v3",
        version: 3,
        expression: {
          op: "match",
          attribute: "plan",
          operator: "eq",
          value: "pro",
        },
      },
    } as const satisfies ExperimentIteration;
    expect(
      assignExperiment(iteration, experimentConformanceConfig, {
        targetingKey: "paid",
        attributes: { plan: "pro" },
      }).eligible,
    ).toBeTrue();
    expect(
      assignExperiment(iteration, experimentConformanceConfig, {
        targetingKey: "free",
        attributes: { plan: "free" },
      }),
    ).toMatchObject({ eligible: false, reason: "FALLTHROUGH" });
  });

  test("safe ramps preserve every previously assigned subject", () => {
    const previous = {
      ...experimentConformanceIteration,
      allocation: [
        { variation: "control", weight: 25_000 },
        { variation: "treatment", weight: 25_000 },
      ],
    } as const satisfies ExperimentIteration;
    const next = {
      ...previous,
      allocation: [
        { variation: "control", weight: 25_000 },
        { variation: "treatment", weight: 50_000 },
      ],
    } as const satisfies ExperimentIteration;
    expect(isAssignmentPreservingRamp(previous, next)).toBeTrue();
    for (let index = 0; index < 5_000; index++) {
      const context = { targetingKey: `ramp-${index}` };
      const before = assignExperiment(
        previous,
        experimentConformanceConfig,
        context,
      );
      const after = assignExperiment(
        next,
        experimentConformanceConfig,
        context,
      );
      if (before.eligible) expect(after.variation).toBe(before.variation);
    }
    expect(
      isAssignmentPreservingRamp(previous, { ...next, salt: "new-population" }),
    ).toBeFalse();
    expect(
      isAssignmentPreservingRamp(previous, {
        ...next,
        allocation: [
          { variation: "control", weight: 30_000 },
          { variation: "treatment", weight: 45_000 },
        ],
      }),
    ).toBeFalse();
    expect(
      isAssignmentPreservingRamp(previous, {
        ...next,
        startedAt: "2031-01-01T00:00:00.000Z",
      }),
    ).toBeFalse();
    expect(
      isAssignmentPreservingRamp(previous, {
        ...next,
        primaryMetric: { key: "checkout-completed", revision: 2 },
      }),
    ).toBeFalse();
    expect(
      isAssignmentPreservingRamp(previous, {
        ...next,
        variations: ["control", "treatment", "third"],
        allocation: [
          ...next.allocation,
          { variation: "third", weight: 10_000 },
        ],
      }),
    ).toBeFalse();
  });

  test("safe A/B/n ramps preserve all prior assignments", () => {
    const previous = {
      ...experimentAbnConformanceIteration,
      allocation: [
        { variation: "control", weight: 20_000 },
        { variation: "treatment", weight: 20_000 },
        { variation: "holdout", weight: 20_000 },
      ],
    } as const satisfies ExperimentIteration;
    const next = {
      ...previous,
      allocation: [
        { variation: "control", weight: 20_000 },
        { variation: "treatment", weight: 20_000 },
        { variation: "holdout", weight: 50_000 },
      ],
    } as const satisfies ExperimentIteration;
    expect(isAssignmentPreservingRamp(previous, next)).toBeTrue();
    let newlyEligible = 0;
    for (let index = 0; index < 10_000; index++) {
      const context = { targetingKey: `abn-ramp-${index}` };
      const before = assignExperiment(
        previous,
        experimentAbnConformanceConfig,
        context,
      );
      const after = assignExperiment(
        next,
        experimentAbnConformanceConfig,
        context,
      );
      if (before.eligible) expect(after.variation).toBe(before.variation);
      else if (after.eligible) newlyEligible++;
    }
    expect(newlyEligible).toBeGreaterThan(2_700);
    expect(newlyEligible).toBeLessThan(3_300);
  });

  test("attribute and Unicode assignment units are deterministic", () => {
    const iteration = {
      ...experimentAbnConformanceIteration,
      id: "checkout-attribute-iteration-1",
      assignmentUnit: { kind: "attribute", attribute: "account.id" },
    } as const satisfies ExperimentIteration;
    const first = assignExperiment(iteration, experimentAbnConformanceConfig, {
      targetingKey: "first-subject",
      attributes: { account: { id: "组织-🚀" } },
    });
    const second = assignExperiment(iteration, experimentAbnConformanceConfig, {
      targetingKey: "different-subject",
      attributes: { account: { id: "组织-🚀" } },
    });
    expect(first).toMatchObject({
      variation: "treatment",
      eligible: true,
      reason: "SPLIT",
    });
    expect(second.variation).toBe(first.variation);
    expect(
      assignExperiment(iteration, experimentAbnConformanceConfig, {
        targetingKey: "missing-attribute",
      }),
    ).toMatchObject({ eligible: false, reason: "SPLIT" });
  });

  test("started iterations allow only identity-stable assignment-preserving ramps", () => {
    const changed = {
      ...experimentConformanceIteration,
      salt: "new-population",
    } as const satisfies ExperimentIteration;
    expect(
      validateIterationReplacement(
        experimentConformanceIteration,
        changed,
        "running",
      ).success,
    ).toBeFalse();
    const previous = {
      ...experimentConformanceIteration,
      allocation: [
        { variation: "control", weight: 25_000 },
        { variation: "treatment", weight: 25_000 },
      ],
    } as const satisfies ExperimentIteration;
    const ramp = {
      ...previous,
      allocation: [
        { variation: "control", weight: 25_000 },
        { variation: "treatment", weight: 50_000 },
      ],
    } as const satisfies ExperimentIteration;
    expect(
      validateIterationReplacement(previous, ramp, "running").success,
    ).toBeTrue();
    expect(
      isAssignmentPreservingRamp(previous, {
        ...ramp,
        id: "checkout-iteration-2",
        number: 2,
      }),
    ).toBeFalse();
    expect(
      validateIterationReplacement(
        experimentConformanceIteration,
        changed,
        "draft",
      ).success,
    ).toBeTrue();
    expect(
      validateIterationReplacement(
        experimentConformanceIteration,
        changed,
        "paused",
      ).success,
    ).toBeFalse();
  });

  test("audience snapshots are explicit and canonical", () => {
    expect(
      validateExperimentIteration({
        ...experimentConformanceIteration,
        audience: { id: "paid", version: 1 },
      }).success,
    ).toBeFalse();
    expect(
      validateExperimentIteration({
        ...experimentConformanceIteration,
        audience: {
          kind: "expression",
          id: "paid",
          version: 1,
          expression: {
            op: "match",
            attribute: "plan",
            operator: "definitely-not-an-operator",
          },
        },
      }).success,
    ).toBeFalse();
    const parsed = parseExperimentIteration({
      ...experimentConformanceIteration,
      hidden: "must-not-survive",
      audience: {
        ...experimentConformanceIteration.audience,
        hidden: "must-not-survive",
      },
    });
    expect(parsed).not.toHaveProperty("hidden");
    expect(parsed.audience).not.toHaveProperty("hidden");
  });

  test("assignment evaluates schedules at the pinned iteration instant", () => {
    const config = {
      ...experimentConformanceConfig,
      flags: {
        checkout: {
          ...experimentConformanceConfig.flags.checkout,
          schedule: {
            start: "2029-12-31T00:00:00.000Z",
            end: "2030-01-02T00:00:00.000Z",
          },
        },
      },
    } as const;
    const first = assignExperiment(experimentConformanceIteration, config, {
      targetingKey: "scheduled",
    });
    const second = assignExperiment(experimentConformanceIteration, config, {
      targetingKey: "scheduled",
    });
    expect(second).toEqual(first);
    expect(first.eligible).toBeTrue();
  });

  test("rejects incomplete variation snapshots and mismatched config versions", () => {
    expect(
      validateExperimentIteration({
        ...experimentConformanceIteration,
        allocation: [{ variation: "control", weight: 100_000 }],
      }).success,
    ).toBeFalse();
    expect(() =>
      assignExperiment(
        experimentConformanceIteration,
        { ...experimentConformanceConfig, configVersion: 12 },
        { targetingKey: "user" },
      ),
    ).toThrow("pinned config");
  });
});
