export type StableJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly StableJsonValue[]
  | { readonly [key: string]: StableJsonValue };

function serialize(value: StableJsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  }

  const record = value as Readonly<Record<string, StableJsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serialize(record[key] as StableJsonValue)}`,
    )
    .join(",")}}`;
}

/**
 * Canonical recursive JSON signature for semantic memoization and comparison.
 * Object keys are sorted at every depth; array order is preserved. An omitted
 * root value has the same empty-object signature used by SDK option defaults.
 */
export function stableJsonSignature(
  value: StableJsonValue | undefined,
): string {
  return value === undefined ? "{}" : serialize(value);
}
