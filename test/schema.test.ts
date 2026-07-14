import { describe, expect, test } from "bun:test";
import { parseConfig, validateConfig } from "../src";
import { conformanceConfig } from "../src/conformance";

describe("schema validation", () => {
  test("accepts the canonical versioned config", () => {
    expect(validateConfig(conformanceConfig)).toEqual({
      success: true,
      value: conformanceConfig,
    });
    expect(parseConfig(conformanceConfig)).toBe(conformanceConfig);
  });

  test("rejects unknown schema versions", () => {
    const result = validateConfig({ schemaVersion: 2, flags: {} });
    expect(result.success).toBeFalse();
    if (!result.success) expect(result.issues[0]?.path).toBe("$.schemaVersion");
  });

  test("reports broken variation references and rollout totals", () => {
    const result = validateConfig({
      schemaVersion: 1,
      flags: {
        bad: {
          enabled: true,
          variations: { a: { value: true } },
          offVariation: "missing",
          fallthrough: {
            rollout: { variations: [{ variation: "missing", weight: 100001 }] },
          },
        },
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
        "weights must total at most 100000",
      );
  });

  test("rejects malformed serve discriminator values", () => {
    const malformed = structuredClone(conformanceConfig) as unknown as {
      flags: Record<string, Record<string, unknown>>;
    };
    malformed.flags.checkout!.fallthrough = { variation: 123 };
    const result = validateConfig(malformed);
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(result.issues).toContainEqual({
        path: "$.flags.checkout.fallthrough.variation",
        message: "must be a string",
      });
  });

  test("rejects invalid windows and duplicate rule ids", () => {
    const result = validateConfig({
      schemaVersion: 1,
      flags: {
        flag: {
          enabled: true,
          variations: { off: { value: false } },
          offVariation: "off",
          schedule: {
            start: "2030-02-01T00:00:00Z",
            end: "2030-01-01T00:00:00Z",
          },
          rules: [
            {
              id: "same",
              when: { op: "match", attribute: "x", operator: "exists" },
              serve: { variation: "off" },
            },
            {
              id: "same",
              when: { op: "match", attribute: "x", operator: "exists" },
              serve: { variation: "off" },
            },
          ],
          fallthrough: { variation: "off" },
        },
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(result.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "start must be before end",
          "must be unique within the flag",
        ]),
      );
  });

  test("rejects non-ISO dates and mixed variation types", () => {
    const result = validateConfig({
      schemaVersion: 1,
      flags: {
        flag: {
          enabled: true,
          variations: { text: { value: "yes" }, number: { value: 1 } },
          offVariation: "text",
          schedule: { start: "tomorrow" },
          fallthrough: { variation: "text" },
        },
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(result.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "must be an ISO-8601 instant",
          "must have the same value type as other variations",
        ]),
      );
  });

  test("rejects client flags with private dependencies", () => {
    const result = validateConfig({
      schemaVersion: 1,
      segments: { secret: { rules: [], visibility: "server" } },
      flags: {
        secret: {
          enabled: true,
          variations: { on: { value: true } },
          offVariation: "on",
          fallthrough: { variation: "on" },
        },
        public: {
          enabled: true,
          visibility: "client",
          variations: { on: { value: true } },
          offVariation: "on",
          prerequisites: [{ flag: "secret", variations: ["on"] }],
          rules: [
            {
              id: "secret",
              when: { op: "segment", segment: "secret" },
              serve: { variation: "on" },
            },
          ],
          fallthrough: { variation: "on" },
        },
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(
        result.issues.filter((issue) => issue.message.includes("server"))
          .length,
      ).toBe(2);
  });

  test("validates provenance and required typed definition metadata", () => {
    const malformed = structuredClone(conformanceConfig) as unknown as {
      configVersion: unknown;
      source: { app: unknown; environment: unknown };
      flags: Record<string, Record<string, unknown>>;
    };
    malformed.configVersion = -1;
    malformed.source.app = "";
    malformed.flags.checkout!.type = "number";
    malformed.flags.checkout!.description = "";
    malformed.flags.checkout!.tags = ["duplicate", "duplicate"];
    malformed.flags.checkout!.owner = "";
    malformed.flags.checkout!.lifecycle = "unknown";
    malformed.flags.checkout!.metadata = { invalid: undefined };

    const result = validateConfig(malformed);
    expect(result.success).toBeFalse();
    if (!result.success) {
      const messages = result.issues.map((issue) => issue.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          "must be a non-negative safe integer",
          "must be a non-empty string",
          "must match declared flag type number",
          "must not contain duplicates",
          "must be draft, active, deprecated, or archived",
          "must contain only JSON values",
        ]),
      );
      expect(
        result.issues.some((issue) => issue.path === "$.source.app"),
      ).toBeTrue();
    }
  });
});
