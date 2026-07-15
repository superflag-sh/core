import { describe, expect, test } from "bun:test";
import {
  featureEventConformanceVectors,
  runFeatureEventConformanceVectors,
} from "../src/conformance";
import {
  createEvaluationEvent,
  exposureDedupeKey,
  featureEventDedupeKey,
  parseFeatureEvent,
  parsePseudonymousSubjectId,
  validateFeatureEvent,
} from "../src/events";

const base = featureEventConformanceVectors[1]!.expected;

describe("feature event contracts", () => {
  test("cross-SDK golden envelopes preserve privacy parity", () => {
    const results = runFeatureEventConformanceVectors();
    expect(results.every((result) => result.pass)).toBeTrue();
    const serialized = JSON.stringify(
      featureEventConformanceVectors.map((vector) =>
        parseFeatureEvent(vector.input, vector.options),
      ),
    );
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("clientKey");
    expect(serialized).not.toContain('"value"');
  });

  test("dimensions default closed and require a bounded explicit allow-list", () => {
    const input = { ...base, dimensions: { release: "2030.1" } };
    expect(validateFeatureEvent(input).success).toBeFalse();
    expect(
      parseFeatureEvent(input, { allowedDimensions: ["release"] }).dimensions,
    ).toEqual({ release: "2030.1" });
    expect(
      validateFeatureEvent(
        { ...base, dimensions: { release: "x".repeat(65) } },
        { allowedDimensions: ["release"] },
      ).success,
    ).toBeFalse();
  });

  test("rejects oversize payloads and unsupported schema versions", () => {
    expect(
      validateFeatureEvent({ ...base, ignored: "x".repeat(20_000) }).success,
    ).toBeFalse();
    expect(
      validateFeatureEvent({ ...base, schemaVersion: 2 }).success,
    ).toBeFalse();
  });

  test("assignment requires an iteration and outcome requires its exposure", () => {
    const { experiment: _experiment, ...withoutExperiment } = base;
    expect(
      validateFeatureEvent({ ...withoutExperiment, kind: "assignment" })
        .success,
    ).toBeFalse();
    expect(
      validateFeatureEvent({
        ...base,
        kind: "outcome",
        exposureId: "evt-rn-1",
        metric: { key: "checkout-completed", revision: 1 },
        value: true,
      }).success,
    ).toBeTrue();
  });

  test("evaluation event creation never copies values, metadata, or context", () => {
    const event = createEvaluationEvent({
      id: "evt-created-1",
      kind: "decision",
      details: {
        flagKey: "checkout",
        source: { app: "store", environment: "production" },
        configVersion: 8,
        value: { private: true },
        variation: "treatment",
        reason: "SPLIT",
        segmentIds: ["private-segment"],
        prerequisites: [],
        timestamp: "2030-01-01T00:00:00.000Z",
        metadata: { secret: "private" },
      },
      sdk: { name: "test", version: "1", platform: "node" },
      subject: {
        id: "psn_1111111111111111",
        namespace: "store",
        revision: 1,
        state: "authenticated",
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("segmentIds");
    expect(serialized).not.toContain("metadata");
  });

  test("rejects raw-looking subject identifiers at the canonical boundary", () => {
    expect(
      validateFeatureEvent({
        ...base,
        subject: { ...base.subject, id: "raw-user-123" },
      }).success,
    ).toBeFalse();
    expect(parsePseudonymousSubjectId("psn_1234567890abcdef")).toBe(
      "psn_1234567890abcdef",
    );
    expect(() => parsePseudonymousSubjectId("raw-user-123")).toThrow();
  });

  test("exposure dedupe ignores delivery id but respects subject rotation", () => {
    const one = parseFeatureEvent(base);
    const retry = parseFeatureEvent({ ...base, id: "evt-rn-retry" });
    const rotated = parseFeatureEvent({
      ...base,
      id: "evt-rn-rotated",
      subject: { ...base.subject, revision: 2 },
    });
    const conflictingVariation = parseFeatureEvent({
      ...base,
      id: "evt-rn-conflict",
      variation: "control",
    });
    if (
      one.kind !== "exposure" ||
      retry.kind !== "exposure" ||
      rotated.kind !== "exposure" ||
      conflictingVariation.kind !== "exposure"
    )
      throw new Error("fixture must be exposure events");
    expect(exposureDedupeKey(one)).toBe(exposureDedupeKey(retry));
    expect(exposureDedupeKey(one)).toBe(
      exposureDedupeKey(conflictingVariation),
    );
    expect(exposureDedupeKey(one)).not.toBe(exposureDedupeKey(rotated));
    expect(featureEventDedupeKey(one)).not.toBe(featureEventDedupeKey(retry));
  });
});
