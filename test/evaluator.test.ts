import { describe, expect, test } from "bun:test";
import { bucket, createEvaluator, type FlagConfig } from "../src";

const definition = {
  description: "Test flag",
  tags: ["test"],
  owner: "sdk-tests",
  lifecycle: "active",
} as const;

const config = {
  schemaVersion: 1,
  source: { app: "core-tests", environment: "test" },
  configVersion: 12,
  segments: {
    beta: {
      included: ["included"],
      excluded: ["blocked"],
      rules: [
        {
          op: "all",
          expressions: [
            { op: "match", attribute: "age", operator: "gte", value: 18 },
            {
              op: "match",
              attribute: "version",
              operator: "semverGte",
              value: "2.0.0",
            },
          ],
        },
      ],
    },
  },
  flags: {
    gate: {
      ...definition,
      type: "boolean",
      enabled: true,
      variations: { no: { value: false }, yes: { value: true } },
      offVariation: "no",
      fallthrough: { variation: "yes" },
    },
    feature: {
      ...definition,
      type: "string",
      enabled: true,
      variations: { off: { value: "off" }, on: { value: "on" } },
      offVariation: "off",
      prerequisites: [{ flag: "gate", variations: ["yes"] }],
      rules: [
        {
          id: "beta",
          when: { op: "segment", segment: "beta" },
          serve: { variation: "on" },
        },
        {
          id: "email",
          when: {
            op: "match",
            attribute: "email",
            operator: "endsWith",
            value: "@example.com",
          },
          serve: { variation: "on" },
        },
      ],
      fallthrough: { variation: "off" },
      metadata: { owner: "growth" },
    },
    disabled: {
      ...definition,
      type: "number",
      enabled: false,
      variations: { off: { value: 0 }, on: { value: 1 } },
      offVariation: "off",
      fallthrough: { variation: "on" },
    },
    partial: {
      ...definition,
      type: "boolean",
      enabled: true,
      variations: { off: { value: false }, on: { value: true } },
      offVariation: "off",
      rules: [
        {
          id: "partial",
          when: { op: "match", attribute: "targetingKey", operator: "exists" },
          serve: { rollout: { variations: [{ variation: "on", weight: 0 }] } },
        },
      ],
      fallthrough: { variation: "off" },
    },
  },
} as const satisfies FlagConfig;

describe("evaluation", () => {
  const evaluator = createEvaluator(config);

  test("returns rich segment and prerequisite details", () => {
    const result = evaluator.string(
      "feature",
      { targetingKey: "person", attributes: { age: 21, version: "2.1.0" } },
      "fallback",
    );
    expect(result).toMatchObject({
      value: "on",
      variation: "on",
      reason: "TARGETING_MATCH",
      ruleId: "beta",
      source: { app: "core-tests", environment: "test" },
      configVersion: 12,
      segmentIds: ["beta"],
      metadata: { owner: "growth" },
    });
    expect(result.prerequisites).toEqual([
      {
        flagKey: "gate",
        variation: "yes",
        satisfied: true,
        reason: "FALLTHROUGH",
      },
    ]);
  });

  test("included and excluded targeting keys are deterministic", () => {
    expect(
      evaluator.string("feature", { targetingKey: "included" }, "fallback")
        .value,
    ).toBe("on");
    expect(
      evaluator.string(
        "feature",
        { targetingKey: "blocked", attributes: { age: 21, version: "2.1.0" } },
        "fallback",
      ).value,
    ).toBe("off");
  });

  test("supports string match operators", () => {
    const result = evaluator.string(
      "feature",
      { targetingKey: "person", attributes: { email: "a@example.com" } },
      "fallback",
    );
    expect(result).toMatchObject({ value: "on", ruleId: "email" });
  });

  test("supports nested attributes and structural JSON equality", () => {
    const nested = createEvaluator({
      schemaVersion: 1,
      source: { app: "core-tests", environment: "nested" },
      configVersion: 2,
      flags: {
        layout: {
          ...definition,
          type: "string",
          enabled: true,
          variations: { old: { value: "old" }, next: { value: "next" } },
          offVariation: "old",
          rules: [
            {
              id: "layout",
              when: {
                op: "match",
                attribute: "preferences.layout",
                operator: "eq",
                value: { density: "compact", columns: 3 },
              },
              serve: { variation: "next" },
            },
          ],
          fallthrough: { variation: "old" },
        },
      },
    } as const);
    expect(
      nested.string(
        "layout",
        {
          targetingKey: "person",
          attributes: {
            preferences: { layout: { columns: 3, density: "compact" } },
          },
        },
        "fallback",
      ),
    ).toMatchObject({ value: "next", ruleId: "layout" });
  });

  test("disabled flags serve the off variation", () => {
    expect(
      evaluator.number("disabled", { targetingKey: "person" }, 9),
    ).toMatchObject({ value: 0, variation: "off", reason: "OFF" });
  });

  test("missing flags and invalid contexts safely return typed fallbacks", () => {
    expect(
      evaluator.boolean("missing" as never, { targetingKey: "person" }, true),
    ).toMatchObject({
      value: true,
      source: { app: "core-tests", environment: "test" },
      configVersion: 12,
      errorCode: "FLAG_NOT_FOUND",
    });
    expect(
      evaluator.string("feature", { targetingKey: "" }, "safe"),
    ).toMatchObject({ value: "safe", errorCode: "INVALID_CONTEXT" });
  });

  test("type mismatches return the caller fallback", () => {
    expect(
      evaluator.boolean("feature", { targetingKey: "person" }, false),
    ).toMatchObject({
      value: false,
      reason: "DEFAULT",
      errorCode: "TYPE_MISMATCH",
    });
  });

  test("an unallocated rule continues to fallthrough", () => {
    expect(
      evaluator.boolean("partial", { targetingKey: "person" }, true),
    ).toMatchObject({ value: false, variation: "off", reason: "FALLTHROUGH" });
  });

  test("hash buckets are stable", () => {
    expect(bucket("flag:salt:user-123")).toBe(45677);
    expect(bucket("flag:salt:user-123")).toBe(bucket("flag:salt:user-123"));
  });

  test("prerequisite cycles fail closed without throwing", () => {
    const cyclic = createEvaluator({
      schemaVersion: 1,
      source: { app: "core-tests", environment: "cycle" },
      configVersion: 3,
      flags: {
        a: {
          ...definition,
          type: "boolean",
          enabled: true,
          variations: { off: { value: false } },
          offVariation: "off",
          prerequisites: [{ flag: "b", variations: ["off"] }],
          fallthrough: { variation: "off" },
        },
        b: {
          ...definition,
          type: "boolean",
          enabled: true,
          variations: { off: { value: false } },
          offVariation: "off",
          prerequisites: [{ flag: "a", variations: ["off"] }],
          fallthrough: { variation: "off" },
        },
      },
    } as const);
    expect(cyclic.boolean("a", { targetingKey: "person" }, true)).toMatchObject(
      { value: true, errorCode: "CYCLE_DETECTED" },
    );
  });
});
