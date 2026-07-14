import { parseConfig } from "./schema";
import type {
  ConfigSource,
  Flag,
  FlagConfig,
  FlagLifecycle,
  FlagValue,
  FlagValueType,
  JsonValue,
  Variation,
} from "./types";

export type LegacyFlagType = "bool" | "string" | "number" | "json";

export interface LegacyFlagValue {
  type: LegacyFlagType;
  value: FlagValue;
  rollout?: { percentage: number };
  variants?: readonly {
    value: FlagValue;
    weight: number;
    name?: string;
  }[];
  clientEnabled?: boolean;
}

export interface LegacyDefinitionOverrides {
  description?: string;
  tags?: readonly string[];
  owner?: string;
  lifecycle?: FlagLifecycle;
}

export interface LegacyMigrationOptions {
  source: ConfigSource;
  configVersion: number;
  definitions?: Readonly<Record<string, LegacyDefinitionOverrides>>;
  defaults?: LegacyDefinitionOverrides;
}

const typeMap: Record<LegacyFlagType, FlagValueType> = {
  bool: "boolean",
  string: "string",
  number: "number",
  json: "object",
};

function runtimeType(value: JsonValue): FlagValueType | "null" {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "object";
}

function defaultValue(type: LegacyFlagType): FlagValue {
  if (type === "bool") return false;
  if (type === "string") return "";
  if (type === "number") return 0;
  return {};
}

function assertValueType(
  flagKey: string,
  type: LegacyFlagType,
  value: FlagValue,
): void {
  if (runtimeType(value) !== typeMap[type])
    throw new TypeError(
      `Legacy flag ${flagKey} declares ${type} but contains ${runtimeType(value)}`,
    );
}

function definitionFor(
  flagKey: string,
  options: LegacyMigrationOptions,
): Required<LegacyDefinitionOverrides> {
  const override = options.definitions?.[flagKey];
  return {
    description:
      override?.description ??
      options.defaults?.description ??
      `Migrated legacy flag ${flagKey}`,
    tags: override?.tags ?? options.defaults?.tags ?? ["legacy"],
    owner: override?.owner ?? options.defaults?.owner ?? "unowned",
    lifecycle: override?.lifecycle ?? options.defaults?.lifecycle ?? "active",
  };
}

function migrateFlag(
  flagKey: string,
  legacy: LegacyFlagValue,
  options: LegacyMigrationOptions,
): Flag {
  if (!(legacy.type in typeMap))
    throw new TypeError(`Legacy flag ${flagKey} has an unsupported type`);
  if (legacy.rollout && legacy.variants)
    throw new TypeError(
      `Legacy flag ${flagKey} cannot have rollout and variants`,
    );
  assertValueType(flagKey, legacy.type, legacy.value);
  const definition = definitionFor(flagKey, options);
  const visibility = legacy.clientEnabled === true ? "client" : "server";

  if (legacy.rollout) {
    const percentage = legacy.rollout.percentage;
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
      throw new TypeError(
        `Legacy flag ${flagKey} rollout must be between 0 and 100`,
      );
    const onWeight = Math.round(percentage * 1_000);
    return {
      ...definition,
      type: typeMap[legacy.type],
      enabled: true,
      visibility,
      variations: {
        on: { value: legacy.value },
        off: { value: defaultValue(legacy.type) },
      },
      offVariation: "off",
      fallthrough: {
        rollout: {
          variations: [
            { variation: "on", weight: onWeight },
            { variation: "off", weight: 100_000 - onWeight },
          ],
          salt: "legacy",
        },
      },
    };
  }

  if (legacy.variants) {
    if (legacy.variants.length === 0)
      throw new TypeError(`Legacy flag ${flagKey} variants must not be empty`);
    const total = legacy.variants.reduce(
      (sum, variant) => sum + variant.weight,
      0,
    );
    if (!Number.isFinite(total) || Math.abs(total - 100) > 0.01)
      throw new TypeError(
        `Legacy flag ${flagKey} variant weights must total 100`,
      );
    const variations: Record<string, Variation> = {};
    const allocations: { variation: string; weight: number }[] = [];
    let allocated = 0;
    legacy.variants.forEach((variant, index) => {
      assertValueType(flagKey, legacy.type, variant.value);
      const id = `variant-${index}`;
      variations[id] = {
        value: variant.value,
        ...(variant.name ? { name: variant.name } : {}),
      };
      const weight =
        index === legacy.variants!.length - 1
          ? 100_000 - allocated
          : Math.round(variant.weight * 1_000);
      allocated += weight;
      allocations.push({ variation: id, weight });
    });
    return {
      ...definition,
      type: typeMap[legacy.type],
      enabled: true,
      visibility,
      variations,
      offVariation: "variant-0",
      fallthrough: {
        rollout: { variations: allocations, salt: "legacy" },
      },
    };
  }

  return {
    ...definition,
    type: typeMap[legacy.type],
    enabled: true,
    visibility,
    variations: { default: { value: legacy.value } },
    offVariation: "default",
    fallthrough: { variation: "default" },
  };
}

/**
 * Converts the current SDK FlagValue/clientEnabled payload into schema v1.
 * Client visibility is fail-closed: only the literal boolean true is exposed.
 */
export function migrateLegacyFlags(
  flags: Readonly<Record<string, LegacyFlagValue>>,
  options: LegacyMigrationOptions,
): FlagConfig {
  const config: FlagConfig = {
    schemaVersion: 1,
    source: options.source,
    configVersion: options.configVersion,
    flags: Object.fromEntries(
      Object.entries(flags).map(([flagKey, flag]) => [
        flagKey,
        migrateFlag(flagKey, flag, options),
      ]),
    ),
  };
  return parseConfig(config);
}
