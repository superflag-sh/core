import { describe, expect, test } from "bun:test";
import {
  createEvaluator,
  createTypedClient,
  generateTypes,
  migrateLegacyFlags,
  projectClientConfig,
  sanitizeContext,
} from "../src";
import {
  evaluateFromText,
  generateTypesFromText,
  validateConfigText,
} from "../src/cli";
import { conformanceConfig, runConformanceVectors } from "../src/conformance";
import { createOpenFeatureProvider } from "../src/openfeature";
import { createClientSnapshot } from "../src/privacy";

describe("shared integrations", () => {
  test("all canonical conformance vectors pass", () => {
    expect(runConformanceVectors()).toEqual(
      expect.arrayContaining([expect.objectContaining({ pass: true })]),
    );
    expect(runConformanceVectors().every((result) => result.pass)).toBeTrue();
  });

  test("client projection excludes server config and metadata", () => {
    const projected = projectClientConfig({
      ...conformanceConfig,
      metadata: { internal: "secret" },
    });
    expect(Object.keys(projected.flags)).toEqual(["entitlement", "checkout"]);
    expect(Object.keys(projected.segments ?? {})).toEqual(["paid"]);
    expect(projected.metadata).toBeUndefined();
    expect(projected.source).toEqual(conformanceConfig.source);
    expect(projected.configVersion).toBe(7);
  });

  test("client projection allow-lists nested fields", () => {
    const config = structuredClone(conformanceConfig);
    Object.assign(config.flags.checkout, {
      privateRule: { email: "rule-secret@example.com" },
    });
    Object.assign(config.flags.checkout.variations.shown, {
      privateValue: "variation-secret",
    });
    Object.assign(config.segments?.paid, {
      internalMembers: ["segment-secret-user"],
    });

    const projected = projectClientConfig(config);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("rule-secret@example.com");
    expect(serialized).not.toContain("variation-secret");
    expect(serialized).not.toContain("segment-secret-user");
    expect(projected.flags.checkout?.variations.shown?.value).toBeTrue();
  });

  test("context sanitization is allow-list only", () => {
    expect(
      sanitizeContext(
        {
          targetingKey: "user",
          attributes: { plan: "pro", email: "private@example.com" },
        },
        ["plan"],
      ),
    ).toEqual({ targetingKey: "user", attributes: { plan: "pro" } });
  });

  test("server-evaluated snapshots contain no rules or context", () => {
    const snapshot = createClientSnapshot(
      conformanceConfig,
      {
        targetingKey: "user",
        attributes: { plan: "pro", email: "private@example.com" },
      },
      { entitlement: false, checkout: false },
      { now: "2029-01-01T00:00:00.000Z" },
    );
    expect(snapshot.flags.checkout?.value).toBeTrue();
    expect(snapshot).toMatchObject({
      source: { app: "conformance", environment: "test" },
      configVersion: 7,
      flags: {
        checkout: {
          source: { app: "conformance", environment: "test" },
          configVersion: 7,
          ruleId: "paid-users",
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
    expect(JSON.stringify(snapshot)).not.toContain('"when"');
  });

  test("codegen emits literal value and variation maps", () => {
    const output = generateTypes(conformanceConfig, { interfaceName: "Flags" });
    expect(output).toContain("export interface Flags");
    expect(output).toContain('"checkout": false | true;');
    expect(output).toContain('"progressive": "control" | "treatment";');
    expect(output).toContain("export interface SuperflagFlagDefinitions");
    expect(output).toContain('readonly owner: "growth"');
    expect(output).toContain("export type SuperflagConfigVersion = 7");
  });

  test("typed client publishes context revisions", () => {
    const client = createTypedClient(createEvaluator(conformanceConfig), {
      targetingKey: "user",
      attributes: { plan: "free" },
    });
    let notifications = 0;
    const unsubscribe = client.subscribe(() => notifications++);
    expect(
      client.get("checkout", false, { now: "2029-01-01T00:00:00Z" }),
    ).toBeFalse();
    client.setContext({ targetingKey: "user", attributes: { plan: "pro" } });
    expect(client.getSnapshot()).toBe(1);
    expect(
      client.get("checkout", false, { now: "2029-01-01T00:00:00Z" }),
    ).toBeTrue();
    expect(
      client.details("checkout", false, {
        now: "2029-01-01T00:00:00Z",
      }),
    ).toMatchObject({
      source: { app: "conformance", environment: "test" },
      configVersion: 7,
      ruleId: "paid-users",
    });
    unsubscribe();
    expect(notifications).toBe(1);
  });

  test("OpenFeature provider maps context, reasons, and variants", async () => {
    const provider = createOpenFeatureProvider(conformanceConfig);
    await provider.initialize();
    const result = await provider.resolveBooleanEvaluation("checkout", false, {
      targetingKey: "user",
      plan: "pro",
    });
    expect(result).toMatchObject({
      value: true,
      variant: "shown",
      reason: "TARGETING_MATCH",
      flagMetadata: {
        "superflag.source.app": "conformance",
        "superflag.source.environment": "test",
        "superflag.configVersion": 7,
        "superflag.ruleId": "paid-users",
      },
    });
    expect(
      await provider.resolveBooleanEvaluation("checkout", false, {}),
    ).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "TARGETING_KEY_MISSING",
    });
    await provider.onClose();
  });

  test("CLI helpers validate, evaluate, and generate without filesystem coupling", () => {
    const text = JSON.stringify(conformanceConfig);
    expect(validateConfigText(text).success).toBeTrue();
    expect(validateConfigText("{").success).toBeFalse();
    expect(
      evaluateFromText(
        text,
        "checkout",
        { targetingKey: "user", attributes: { plan: "pro" } },
        false,
        { now: "2029-01-01T00:00:00Z" },
      ).value,
    ).toBeTrue();
    expect(generateTypesFromText(text)).toContain("SuperflagFlagValues");
  });

  test("legacy migration preserves values and fails client visibility closed", () => {
    const migrated = migrateLegacyFlags(
      {
        public: { type: "bool", value: true, clientEnabled: true },
        private: { type: "string", value: "private" },
        rollout: {
          type: "number",
          value: 42,
          rollout: { percentage: 25 },
          clientEnabled: false,
        },
        experiment: {
          type: "string",
          value: "control",
          variants: [
            { name: "Control", value: "control", weight: 50 },
            { name: "Treatment", value: "treatment", weight: 50 },
          ],
        },
      },
      {
        source: { app: "legacy-app", environment: "production" },
        configVersion: 19,
        defaults: { owner: "migration-team", lifecycle: "deprecated" },
        definitions: {
          public: {
            description: "Public legacy flag",
            tags: ["legacy", "public"],
          },
        },
      },
    );

    expect(migrated).toMatchObject({
      source: { app: "legacy-app", environment: "production" },
      configVersion: 19,
      flags: {
        public: {
          type: "boolean",
          description: "Public legacy flag",
          tags: ["legacy", "public"],
          owner: "migration-team",
          lifecycle: "deprecated",
          visibility: "client",
        },
        private: { type: "string", visibility: "server" },
        rollout: { type: "number", visibility: "server" },
      },
    });
    expect(projectClientConfig(migrated).flags).toHaveProperty("public");
    expect(projectClientConfig(migrated).flags).not.toHaveProperty("private");
    expect(
      createEvaluator(migrated).string(
        "private",
        { targetingKey: "legacy-user" },
        "fallback",
      ).value,
    ).toBe("private");
    expect(migrated.flags.experiment?.variations["variant-1"]?.name).toBe(
      "Treatment",
    );
  });

  test("legacy migration treats malformed clientEnabled as private", () => {
    const migrated = migrateLegacyFlags(
      {
        hidden: {
          type: "bool",
          value: true,
          clientEnabled: "true",
        },
      } as unknown as Parameters<typeof migrateLegacyFlags>[0],
      {
        source: { app: "legacy-app", environment: "test" },
        configVersion: 1,
      },
    );
    expect(migrated.flags.hidden?.visibility).toBe("server");
    expect(Object.keys(projectClientConfig(migrated).flags)).toEqual([]);
  });
});
