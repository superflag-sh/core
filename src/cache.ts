/**
 * Portable identity binding for caches owned by platform adapters.
 *
 * This module deliberately owns no persistence or lifecycle policy. It keeps the
 * credential/endpoint fingerprint and persisted identity contract identical for
 * every adapter without importing browser, Node, or React Native APIs.
 */

export const CACHE_SCHEMA_VERSION = 3;
export const LEGACY_CACHE_KEYS = ["superflag:cache:v1"] as const;

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

export interface CacheScope {
  readonly bindingKey: string;
  readonly legacyCacheKey: string;
  readonly clientKeyFingerprint: string;
  readonly endpointFingerprint: string;
  readonly configUrl: string;
}

export interface CacheIdentity {
  readonly appId: string;
  readonly environment: string;
}

export interface PersistedCacheBinding extends CacheIdentity {
  readonly schemaVersion: 3;
  readonly clientKeyFingerprint: string;
  readonly endpointFingerprint: string;
}

/** The adapter-neutral fields validated before a platform parses its config. */
export interface IdentityBoundCacheEntry extends PersistedCacheBinding {
  readonly flags: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly etag: string;
  readonly fetchedAt: number;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function toUtf8Bytes(input: string): number[] {
  const bytes: number[] = [];

  for (let index = 0; index < input.length; index += 1) {
    let codePoint = input.charCodeAt(index);

    if (
      codePoint >= 0xd800 &&
      codePoint <= 0xdbff &&
      index + 1 < input.length
    ) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return bytes;
}

/** Pure JavaScript SHA-256 for browsers and Hermes without crypto globals. */
export function sha256(input: string): string {
  const bytes = toUtf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);

  while (bytes.length % 64 !== 56) bytes.push(0);

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push(
    (high >>> 24) & 0xff,
    (high >>> 16) & 0xff,
    (high >>> 8) & 0xff,
    high & 0xff,
    (low >>> 24) & 0xff,
    (low >>> 16) & 0xff,
    (low >>> 8) & 0xff,
    low & 0xff,
  );

  const hash: [number, number, number, number, number, number, number, number] =
    [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ];
  const words = new Array<number>(64).fill(0);
  const word = (index: number): number => words[index] ?? 0;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        (((bytes[wordOffset] ?? 0) << 24) |
          ((bytes[wordOffset + 1] ?? 0) << 16) |
          ((bytes[wordOffset + 2] ?? 0) << 8) |
          (bytes[wordOffset + 3] ?? 0)) >>>
        0;
    }

    for (let index = 16; index < 64; index += 1) {
      const value15 = word(index - 15);
      const value2 = word(index - 2);
      const sigma0 =
        rotateRight(value15, 7) ^ rotateRight(value15, 18) ^ (value15 >>> 3);
      const sigma1 =
        rotateRight(value2, 17) ^ rotateRight(value2, 19) ^ (value2 >>> 10);
      words[index] =
        (word(index - 16) + sigma0 + word(index - 7) + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + word(index)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function normalizeConfigUrl(configUrl: string): string {
  return configUrl.trim().replace(/\/+$/, "");
}

export function createCacheScope(
  configUrl: string,
  clientKey: string,
): CacheScope {
  const normalizedUrl = normalizeConfigUrl(configUrl);
  const endpointFingerprint = sha256(normalizedUrl);
  const clientKeyFingerprint = sha256(clientKey);
  const namespace = `${endpointFingerprint}:${clientKeyFingerprint}`;

  return {
    bindingKey: `superflag:binding:v${CACHE_SCHEMA_VERSION}:${namespace}`,
    legacyCacheKey: `superflag:cache:v2:${namespace}`,
    clientKeyFingerprint,
    endpointFingerprint,
    configUrl: normalizedUrl,
  };
}

export function createCacheKey(
  scope: CacheScope,
  identity: CacheIdentity,
): string {
  return [
    "superflag:cache",
    `v${CACHE_SCHEMA_VERSION}`,
    scope.endpointFingerprint,
    scope.clientKeyFingerprint,
    sha256(identity.appId),
    sha256(identity.environment),
  ].join(":");
}

export function createPersistedCacheBinding(
  scope: CacheScope,
  identity: CacheIdentity,
): PersistedCacheBinding {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    endpointFingerprint: scope.endpointFingerprint,
    clientKeyFingerprint: scope.clientKeyFingerprint,
    appId: identity.appId,
    environment: identity.environment,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    typeof value.environment === "string" &&
    value.environment.length > 0
  );
}

export function isPersistedCacheBinding(
  value: unknown,
  scope: CacheScope,
): value is PersistedCacheBinding {
  if (!isRecord(value)) return false;

  return (
    value.schemaVersion === CACHE_SCHEMA_VERSION &&
    value.endpointFingerprint === scope.endpointFingerprint &&
    value.clientKeyFingerprint === scope.clientKeyFingerprint &&
    hasIdentity(value)
  );
}

/**
 * Validates only the adapter-neutral cache envelope. The owning adapter must
 * parse and validate its `config` payload before use.
 */
export function isIdentityBoundCacheEntry(
  value: unknown,
  scope: CacheScope,
  binding: PersistedCacheBinding,
): value is IdentityBoundCacheEntry {
  if (!isRecord(value)) return false;
  const flags = value.flags;

  return (
    value.schemaVersion === CACHE_SCHEMA_VERSION &&
    value.endpointFingerprint === scope.endpointFingerprint &&
    value.clientKeyFingerprint === scope.clientKeyFingerprint &&
    value.appId === binding.appId &&
    value.environment === binding.environment &&
    isRecord(flags) &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 0 &&
    typeof value.etag === "string" &&
    value.etag.length > 0 &&
    typeof value.fetchedAt === "number" &&
    Number.isFinite(value.fetchedAt) &&
    value.fetchedAt >= 0
  );
}
