import { describe, expect, test } from "bun:test";
import {
  experimentConformanceConfig,
  experimentConformanceIteration,
  runExperimentConformanceVectors,
} from "../src/conformance";
import {
  assignExperiment,
  type Experiment,
  type ExperimentIteration,
  isAssignmentPreservingRamp,
  parseExperimentIteration,
  validateExperiment,
  validateExperimentIteration,
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

  test("golden A/B/n vectors are deterministic across repeated evaluation", () => {
    expect(
      runExperimentConformanceVectors().every((result) => result.pass),
    ).toBeTrue();
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
