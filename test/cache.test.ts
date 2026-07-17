import { describe, expect, test } from "bun:test";
import {
  CACHE_SCHEMA_VERSION,
  createCacheKey,
  createCacheScope,
  createPersistedCacheBinding,
  isIdentityBoundCacheEntry,
  isPersistedCacheBinding,
  sha256,
} from "../src/cache.js";

describe("portable cache identity", () => {
  test("matches SHA-256 vectors without runtime crypto", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256("pub_prod_super-secret")).toBe(
      "eb196c5cf9858a7af98a2d53c01b09c076b7f230dc858e93e0ce2931a38be1d4",
    );
    expect(sha256("😀")).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );
  });

  test("matches platform UTF-8 and SHA-256 for malformed UTF-16", async () => {
    const inputs = [
      "plain ASCII",
      "café",
      "😀",
      "\ud800",
      "\udc00",
      "\ud800A",
      "A\udc00",
      "\ud800\udc00",
    ];

    for (const input of inputs) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input),
      );
      const expected = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      expect(sha256(input)).toBe(expected);
    }
  });

  test("binds cache keys to endpoint, credential, app, and environment", () => {
    const scope = createCacheScope(
      "https://superflag.sh/api/v1/public-config/",
      "pub_secret",
    );
    const prod = createPersistedCacheBinding(scope, {
      appId: "app-a",
      environment: "prod",
    });
    const staging = createPersistedCacheBinding(scope, {
      appId: "app-a",
      environment: "staging",
    });

    expect(scope.configUrl).toBe("https://superflag.sh/api/v1/public-config");
    expect(createCacheKey(scope, prod)).not.toBe(
      createCacheKey(scope, staging),
    );
    expect(createCacheKey(scope, prod)).not.toContain("pub_secret");
    expect(isPersistedCacheBinding(prod, scope)).toBe(true);
  });

  test("validates the neutral envelope and leaves config parsing to adapters", () => {
    const scope = createCacheScope("https://example.test/config", "pub_key");
    const binding = createPersistedCacheBinding(scope, {
      appId: "app-a",
      environment: "prod",
    });
    const entry = {
      ...binding,
      schemaVersion: CACHE_SCHEMA_VERSION,
      flags: {},
      version: 3,
      etag: '"v3"',
      fetchedAt: 100,
      config: { deliberately: "not validated here" },
    };

    expect(isIdentityBoundCacheEntry(entry, scope, binding)).toBe(true);
    expect(
      isIdentityBoundCacheEntry(
        { ...entry, clientKeyFingerprint: "wrong" },
        scope,
        binding,
      ),
    ).toBe(false);
    expect(
      isIdentityBoundCacheEntry({ ...entry, appId: "other" }, scope, binding),
    ).toBe(false);
  });
});
