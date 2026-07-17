# `@superflag-sh/core`

Dependency-free, deterministic feature-flag evaluation shared by Superflag's React, React Native, Node, and CLI SDKs. The package owns the versioned configuration contract, validation, targeting semantics, safe fallbacks, evaluation details, privacy projection, type generation, and OpenFeature provider adapter.

## Quick start

```ts
import { createEvaluator, defineConfig } from "@superflag-sh/core";

const config = defineConfig({
  schemaVersion: 1,
  source: { app: "checkout", environment: "prod" },
  configVersion: 42,
  flags: {
    "new-checkout": {
      type: "boolean",
      description: "Enable the redesigned checkout.",
      tags: ["checkout", "web"],
      owner: "growth",
      lifecycle: "active",
      enabled: true,
      variations: {
        off: { value: false },
        on: { value: true },
      },
      offVariation: "off",
      rules: [
        {
          id: "pro-users",
          when: { op: "match", attribute: "plan", operator: "eq", value: "pro" },
          serve: { variation: "on" },
        },
      ],
      fallthrough: { variation: "off" },
    },
  },
} as const);

const flags = createEvaluator(config);
const result = flags.boolean(
  "new-checkout",
  { targetingKey: "user_123", attributes: { plan: "pro" } },
  false,
);
// { value: true, configVersion: 42, source: { app: "checkout", environment: "prod" },
//   variation: "on", reason: "TARGETING_MATCH", ruleId: "pro-users", ... }
```

`targetingKey` is required and is the default deterministic bucketing input. Attributes may be JSON values, including nested objects addressed with dot-separated paths. Times are ISO-8601 instants; schedule starts are inclusive and ends are exclusive. Rollout weights are integer units out of 100,000. Progressive rollouts interpolate weights at the supplied evaluation time, so tests and distributed SDKs remain reproducible.

Typed methods (`boolean`, `string`, `number`, and `object`) always return the caller's fallback on missing flags, invalid contexts, evaluation errors, or type mismatches. Inspect `errorCode` and `errorMessage` in the returned details; ordinary targeting misses are not errors.

## Deterministic inspection and simulation

`@superflag-sh/core/inspection` exposes pure diagnostics built on the same evaluator and serve-selection semantics:

```ts
import {
  explainEvaluation,
  simulateProposedConfig,
  testSegmentMembership,
} from "@superflag-sh/core/inspection";

const explanation = explainEvaluation(
  config,
  "new-checkout",
  { targetingKey: "user_123", attributes: { plan: "pro" } },
  false,
  "2030-01-01T00:00:00.000Z",
);

// eligibility -> assignment -> evaluation -> exposure-candidate
console.log(explanation.stages);
```

Inspection always requires an explicit valid time. Rollout explanations include the 100,000-unit bucket, allocation ranges, bucket attribute name, and salt, but never copy the raw targeting key or attribute value into the result. `testSegmentMembership` delegates to the evaluator's expression engine. `dependencyPaths` and `impactPaths` return deterministic flag/segment graph paths. `simulateProposedConfig` evaluates current and proposed documents through the same explanation path, so its `after` details have direct evaluator parity. An exposure candidate is diagnostic provenance only; it does not emit telemetry or imply that the application actually displayed a feature.

## Privacy and client delivery

Flags and segments default to `visibility: "server"`. `projectClientConfig` includes only entries explicitly marked `"client"`, omits arbitrary metadata by default, and validation rejects a client flag that depends on a server-only flag or segment. Because a client-evaluated bundle necessarily reveals its targeting rules and comparison values, use `createClientSnapshot` when those rules are sensitive: it sends evaluated values and safe provenance details without rule definitions, segments, or user attributes. A matching `ruleId` is included as an opaque reference for diagnostics. `sanitizeContext` copies only an explicit attribute allow-list.

Framework entry points are dependency-free: `@superflag-sh/core/react`, `/react-native`, `/node`, and `/cli`. The React stores expose `subscribe` and `getSnapshot` for `useSyncExternalStore`; the framework packages remain responsible for hooks and transport.

Platform adapters share the runtime-neutral cache contract from
`@superflag-sh/core` (also available as `@superflag-sh/core/cache`). It provides
portable SHA-256 fingerprints, endpoint/key/app/environment cache scoping, and
shared envelope validation; each adapter remains responsible for persistence,
lifecycle, and parsing its configuration payload.

## OpenFeature

```ts
import { OpenFeature } from "@openfeature/server-sdk";
import { createOpenFeatureProvider } from "@superflag-sh/core/openfeature";

await OpenFeature.setProviderAndWait(createOpenFeatureProvider(config));
```

`@openfeature/server-sdk` is an optional peer and is never imported at runtime. The returned provider is structurally compatible, keeping core usable without installing OpenFeature.

## Schema and code generation

Use `validateConfig(unknown)` for issue lists, `parseConfig(unknown)` to throw on invalid input, and `schema.safeParse` for a compact schema-like API. Every flag co-locates its definition (`type`, `description`, `tags`, `owner`, and `lifecycle`) with environment behavior. `generateTypes(config)` emits value, variation, definition, source, and configuration-version types. The `/cli` entry point provides JSON-text helpers without owning filesystem or process behavior.

Definitions can still be shared across environment documents without introducing a second schema in v1:

```ts
const definitions = {
  checkout: {
    type: "boolean",
    description: "Enable the redesigned checkout.",
    tags: ["checkout"],
    owner: "growth",
    lifecycle: "active",
  },
} as const;

const prod = defineConfig({
  schemaVersion: 1,
  source: { app: "store", environment: "prod" },
  configVersion: 42,
  flags: {
    checkout: {
      ...definitions.checkout,
      enabled: true,
      variations: { off: { value: false }, on: { value: true } },
      offVariation: "off",
      fallthrough: { variation: "off" },
    },
  },
});
```

## Legacy SDK migration

`migrateLegacyFlags` converts the current SDK `{ type, value, rollout, variants, clientEnabled }` payload incrementally:

```ts
import { migrateLegacyFlags } from "@superflag-sh/core/legacy";

const config = migrateLegacyFlags(legacyFlags, {
  source: { app: "store", environment: "prod" },
  configVersion: 42,
  defaults: { owner: "platform", lifecycle: "active" },
});
```

Only literal `clientEnabled: true` becomes `visibility: "client"`; false, missing, and malformed values stay server-only. Legacy percentage and variant weights are converted to 100,000-unit rollouts. The new stable hash differs from the old SDK's Murmur3 bucketing, so percentage sizes are preserved but individual cohort membership may change during migration.

The `/conformance` entry point exports the canonical config, vectors, and runner. Other SDKs should run these vectors unchanged to guarantee identical scheduling, segment, prerequisite, progressive, reason, and variation behavior.

## Migration notes

When moving evaluation out of an existing SDK:

1. Convert legacy user identifiers to `{ targetingKey, attributes }`; do not place the identifier only in attributes.
2. Add `schemaVersion: 1`, `source`, `configVersion`, named `variations`, an explicit `offVariation`, and a `fallthrough` serve instruction to every flag.
3. Add the required definition fields: `type`, `description`, `tags`, `owner`, and `lifecycle`.
4. Replace percentage values with integer weights totaling at most 100,000. A remainder intentionally means "no allocation" and falls through when used by a rule.
5. Replace SDK-specific targeting callbacks with the serializable rule AST (`all`, `any`, `not`, `match`, and `segment`).
6. Mark browser/device-safe flags and their dependencies `visibility: "client"`; everything else stays server-only.
7. Switch value-only calls to typed evaluation details during rollout so fallback errors and configuration provenance are observable. The `.value` field preserves the old value-returning behavior.
8. Pin evaluation `now` in fixtures and run the shared conformance vectors before removing legacy evaluators.

Configuration version changes are intentionally rejected rather than guessed. Add a migration before accepting a future schema version.
