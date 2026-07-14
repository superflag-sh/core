import {
  type Flag,
  type FlagConfig,
  type JsonValue,
  type MatchOperator,
  type Rollout,
  SCHEMA_VERSION,
  type Schedule,
  type Serve,
  type TargetingExpression,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

const operators = new Set<MatchOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "matches",
  "exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "semverEq",
  "semverGt",
  "semverGte",
  "semverLt",
  "semverLte",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJson = (value: unknown): value is JsonValue => {
  if (value === null || ["string", "boolean"].includes(typeof value))
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
};

const valueType = (
  value: JsonValue,
): "boolean" | "string" | "number" | "object" => {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "object";
};

const flagTypes = new Set(["boolean", "string", "number", "object"]);
const lifecycles = new Set(["draft", "active", "deprecated", "archived"]);

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO_INSTANT.test(value) &&
  Number.isFinite(Date.parse(value));

function validateSchedule(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): value is Schedule {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (value.start !== undefined && !validDate(value.start))
    issues.push({
      path: `${path}.start`,
      message: "must be an ISO-8601 instant",
    });
  if (value.end !== undefined && !validDate(value.end))
    issues.push({
      path: `${path}.end`,
      message: "must be an ISO-8601 instant",
    });
  if (
    validDate(value.start) &&
    validDate(value.end) &&
    Date.parse(value.start) >= Date.parse(value.end)
  )
    issues.push({ path, message: "start must be before end" });
  return true;
}

function validateRollout(
  value: unknown,
  path: string,
  variationIds: Set<string>,
  issues: ValidationIssue[],
): value is Rollout {
  if (
    !isRecord(value) ||
    !Array.isArray(value.variations) ||
    value.variations.length === 0
  ) {
    issues.push({ path, message: "must contain a non-empty variations array" });
    return false;
  }
  let total = 0;
  const seenVariations = new Set<string>();
  value.variations.forEach((allocation, index) => {
    const itemPath = `${path}.variations[${index}]`;
    if (!isRecord(allocation))
      return issues.push({ path: itemPath, message: "must be an object" });
    if (
      typeof allocation.variation !== "string" ||
      !variationIds.has(allocation.variation)
    )
      issues.push({
        path: `${itemPath}.variation`,
        message: "must reference a variation on this flag",
      });
    else if (seenVariations.has(allocation.variation))
      issues.push({
        path: `${itemPath}.variation`,
        message: "must be unique within the rollout",
      });
    else seenVariations.add(allocation.variation);
    if (
      !Number.isInteger(allocation.weight) ||
      (allocation.weight as number) < 0
    )
      issues.push({
        path: `${itemPath}.weight`,
        message: "must be a non-negative integer",
      });
    else total += allocation.weight as number;
  });
  if (total > 100_000)
    issues.push({ path, message: "weights must total at most 100000" });
  if (value.bucketBy !== undefined && typeof value.bucketBy !== "string")
    issues.push({ path: `${path}.bucketBy`, message: "must be a string" });
  if (value.salt !== undefined && typeof value.salt !== "string")
    issues.push({ path: `${path}.salt`, message: "must be a string" });
  return true;
}

function validateServe(
  value: unknown,
  path: string,
  variationIds: Set<string>,
  issues: ValidationIssue[],
): value is Serve {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  const choices = ["variation", "rollout", "progressive"].filter(
    (key) => value[key] !== undefined,
  );
  if (choices.length !== 1) {
    issues.push({
      path,
      message: "must specify exactly one of variation, rollout, or progressive",
    });
    return false;
  }
  if (value.variation !== undefined) {
    if (typeof value.variation !== "string")
      issues.push({
        path: `${path}.variation`,
        message: "must be a string",
      });
    else if (!variationIds.has(value.variation))
      issues.push({
        path: `${path}.variation`,
        message: "must reference a variation on this flag",
      });
  }
  if (value.rollout !== undefined)
    validateRollout(value.rollout, `${path}.rollout`, variationIds, issues);
  if (value.progressive !== undefined) {
    if (!isRecord(value.progressive))
      issues.push({
        path: `${path}.progressive`,
        message: "must be an object",
      });
    else {
      const progressive = value.progressive;
      if (!validDate(progressive.start))
        issues.push({
          path: `${path}.progressive.start`,
          message: "must be an ISO-8601 instant",
        });
      if (!validDate(progressive.end))
        issues.push({
          path: `${path}.progressive.end`,
          message: "must be an ISO-8601 instant",
        });
      if (
        validDate(progressive.start) &&
        validDate(progressive.end) &&
        Date.parse(progressive.start) >= Date.parse(progressive.end)
      )
        issues.push({
          path: `${path}.progressive`,
          message: "start must be before end",
        });
      validateRollout(
        progressive.from,
        `${path}.progressive.from`,
        variationIds,
        issues,
      );
      validateRollout(
        progressive.to,
        `${path}.progressive.to`,
        variationIds,
        issues,
      );
      if (
        isRecord(progressive.from) &&
        isRecord(progressive.to) &&
        progressive.to.bucketBy !== undefined &&
        progressive.from.bucketBy !== undefined &&
        progressive.to.bucketBy !== progressive.from.bucketBy
      )
        issues.push({
          path: `${path}.progressive`,
          message: "from and to must use the same bucketBy",
        });
      if (
        isRecord(progressive.from) &&
        isRecord(progressive.to) &&
        progressive.to.salt !== undefined &&
        progressive.from.salt !== undefined &&
        progressive.to.salt !== progressive.from.salt
      )
        issues.push({
          path: `${path}.progressive`,
          message: "from and to must use the same salt",
        });
    }
  }
  return true;
}

function validateExpression(
  value: unknown,
  path: string,
  segmentIds: Set<string>,
  issues: ValidationIssue[],
): value is TargetingExpression {
  if (!isRecord(value) || typeof value.op !== "string") {
    issues.push({ path, message: "must be a targeting expression" });
    return false;
  }
  if (value.op === "all" || value.op === "any") {
    if (!Array.isArray(value.expressions))
      issues.push({ path: `${path}.expressions`, message: "must be an array" });
    else
      value.expressions.forEach((entry, index) =>
        validateExpression(
          entry,
          `${path}.expressions[${index}]`,
          segmentIds,
          issues,
        ),
      );
  } else if (value.op === "not") {
    validateExpression(
      value.expression,
      `${path}.expression`,
      segmentIds,
      issues,
    );
  } else if (value.op === "segment") {
    if (typeof value.segment !== "string" || !segmentIds.has(value.segment))
      issues.push({
        path: `${path}.segment`,
        message: "must reference an existing segment",
      });
  } else if (value.op === "match") {
    if (typeof value.attribute !== "string" || value.attribute.length === 0)
      issues.push({
        path: `${path}.attribute`,
        message: "must be a non-empty string",
      });
    if (!operators.has(value.operator as MatchOperator))
      issues.push({ path: `${path}.operator`, message: "is not supported" });
    if (value.operator !== "exists" && value.value === undefined)
      issues.push({
        path: `${path}.value`,
        message: "is required for this operator",
      });
    if (value.value !== undefined && !isJson(value.value))
      issues.push({
        path: `${path}.value`,
        message: "must be a JSON-compatible attribute value",
      });
  } else issues.push({ path: `${path}.op`, message: "is not supported" });
  return true;
}

function referencedSegments(expression: TargetingExpression): string[] {
  if (expression.op === "segment") return [expression.segment];
  if (expression.op === "not") return referencedSegments(expression.expression);
  if (expression.op === "all" || expression.op === "any")
    return expression.expressions.flatMap(referencedSegments);
  return [];
}

function validateFlag(
  value: unknown,
  path: string,
  flagIds: Set<string>,
  segmentIds: Set<string>,
  issues: ValidationIssue[],
): value is Flag {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  if (typeof value.enabled !== "boolean")
    issues.push({ path: `${path}.enabled`, message: "must be a boolean" });
  if (typeof value.type !== "string" || !flagTypes.has(value.type))
    issues.push({
      path: `${path}.type`,
      message: "must be boolean, string, number, or object",
    });
  if (typeof value.description !== "string" || value.description.trim() === "")
    issues.push({
      path: `${path}.description`,
      message: "must be a non-empty string",
    });
  if (typeof value.owner !== "string" || value.owner.trim() === "")
    issues.push({
      path: `${path}.owner`,
      message: "must be a non-empty string",
    });
  if (typeof value.lifecycle !== "string" || !lifecycles.has(value.lifecycle))
    issues.push({
      path: `${path}.lifecycle`,
      message: "must be draft, active, deprecated, or archived",
    });
  if (
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === "string" && tag.trim() !== "")
  )
    issues.push({
      path: `${path}.tags`,
      message: "must be an array of non-empty strings",
    });
  else if (new Set(value.tags).size !== value.tags.length)
    issues.push({
      path: `${path}.tags`,
      message: "must not contain duplicates",
    });
  if (
    !isRecord(value.variations) ||
    Object.keys(value.variations).length === 0
  ) {
    issues.push({
      path: `${path}.variations`,
      message: "must be a non-empty object",
    });
    return false;
  }
  const variationIds = new Set(Object.keys(value.variations));
  let variationKind: string | undefined;
  for (const [key, variation] of Object.entries(value.variations)) {
    if (
      !isRecord(variation) ||
      !isJson(variation.value) ||
      variation.value === null
    )
      issues.push({
        path: `${path}.variations.${key}.value`,
        message: "must be a non-null JSON value",
      });
    else {
      const kind = valueType(variation.value);
      variationKind ??= kind;
      if (variationKind !== kind)
        issues.push({
          path: `${path}.variations.${key}.value`,
          message: "must have the same value type as other variations",
        });
      if (
        typeof value.type === "string" &&
        flagTypes.has(value.type) &&
        value.type !== kind
      )
        issues.push({
          path: `${path}.variations.${key}.value`,
          message: `must match declared flag type ${value.type}`,
        });
    }
  }
  if (
    typeof value.offVariation !== "string" ||
    !variationIds.has(value.offVariation)
  )
    issues.push({
      path: `${path}.offVariation`,
      message: "must reference a variation on this flag",
    });
  validateServe(value.fallthrough, `${path}.fallthrough`, variationIds, issues);
  if (value.schedule !== undefined)
    validateSchedule(value.schedule, `${path}.schedule`, issues);
  if (
    value.visibility !== undefined &&
    value.visibility !== "client" &&
    value.visibility !== "server"
  )
    issues.push({
      path: `${path}.visibility`,
      message: "must be client or server",
    });
  if (
    value.metadata !== undefined &&
    (!isRecord(value.metadata) || !Object.values(value.metadata).every(isJson))
  )
    issues.push({
      path: `${path}.metadata`,
      message: "must contain only JSON values",
    });
  if (value.prerequisites !== undefined) {
    if (!Array.isArray(value.prerequisites))
      issues.push({
        path: `${path}.prerequisites`,
        message: "must be an array",
      });
    else
      value.prerequisites.forEach((prerequisite, index) => {
        const itemPath = `${path}.prerequisites[${index}]`;
        if (!isRecord(prerequisite))
          return issues.push({ path: itemPath, message: "must be an object" });
        if (
          typeof prerequisite.flag !== "string" ||
          !flagIds.has(prerequisite.flag)
        )
          issues.push({
            path: `${itemPath}.flag`,
            message: "must reference an existing flag",
          });
        if (
          !Array.isArray(prerequisite.variations) ||
          !prerequisite.variations.every((entry) => typeof entry === "string")
        )
          issues.push({
            path: `${itemPath}.variations`,
            message: "must be an array of variation ids",
          });
      });
  }
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules))
      issues.push({ path: `${path}.rules`, message: "must be an array" });
    else {
      const ruleIds = new Set<string>();
      value.rules.forEach((rule, index) => {
        const itemPath = `${path}.rules[${index}]`;
        if (!isRecord(rule))
          return issues.push({ path: itemPath, message: "must be an object" });
        if (typeof rule.id !== "string" || rule.id.length === 0)
          issues.push({
            path: `${itemPath}.id`,
            message: "must be a non-empty string",
          });
        else if (ruleIds.has(rule.id))
          issues.push({
            path: `${itemPath}.id`,
            message: "must be unique within the flag",
          });
        else ruleIds.add(rule.id);
        validateExpression(rule.when, `${itemPath}.when`, segmentIds, issues);
        validateServe(rule.serve, `${itemPath}.serve`, variationIds, issues);
        if (rule.schedule !== undefined)
          validateSchedule(rule.schedule, `${itemPath}.schedule`, issues);
      });
    }
  }
  return true;
}

export function validateConfig(input: unknown): ValidationResult<FlagConfig> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input))
    return {
      success: false,
      issues: [{ path: "$", message: "must be an object" }],
    };
  if (input.schemaVersion !== SCHEMA_VERSION)
    issues.push({
      path: "$.schemaVersion",
      message: `must equal ${SCHEMA_VERSION}`,
    });
  if (
    !Number.isSafeInteger(input.configVersion) ||
    (input.configVersion as number) < 0
  )
    issues.push({
      path: "$.configVersion",
      message: "must be a non-negative safe integer",
    });
  if (!isRecord(input.source))
    issues.push({ path: "$.source", message: "must be an object" });
  else {
    if (typeof input.source.app !== "string" || input.source.app.trim() === "")
      issues.push({
        path: "$.source.app",
        message: "must be a non-empty string",
      });
    if (
      typeof input.source.environment !== "string" ||
      input.source.environment.trim() === ""
    )
      issues.push({
        path: "$.source.environment",
        message: "must be a non-empty string",
      });
  }
  if (!isRecord(input.flags))
    issues.push({ path: "$.flags", message: "must be an object" });
  if (input.segments !== undefined && !isRecord(input.segments))
    issues.push({ path: "$.segments", message: "must be an object" });
  if (
    input.metadata !== undefined &&
    (!isRecord(input.metadata) || !Object.values(input.metadata).every(isJson))
  )
    issues.push({
      path: "$.metadata",
      message: "must contain only JSON values",
    });
  if (
    !isRecord(input.flags) ||
    (input.segments !== undefined && !isRecord(input.segments))
  )
    return { success: false, issues };

  const flags = input.flags as Record<string, unknown>;
  const segments = (input.segments ?? {}) as Record<string, unknown>;
  const flagIds = new Set(Object.keys(flags));
  const segmentIds = new Set(Object.keys(segments));

  for (const [key, segment] of Object.entries(segments)) {
    const path = `$.segments.${key}`;
    if (!isRecord(segment)) {
      issues.push({ path, message: "must be an object" });
      continue;
    }
    if (segment.schedule !== undefined)
      validateSchedule(segment.schedule, `${path}.schedule`, issues);
    if (
      segment.visibility !== undefined &&
      segment.visibility !== "client" &&
      segment.visibility !== "server"
    )
      issues.push({
        path: `${path}.visibility`,
        message: "must be client or server",
      });
    for (const field of ["included", "excluded"] as const) {
      if (
        segment[field] !== undefined &&
        (!Array.isArray(segment[field]) ||
          !(segment[field] as unknown[]).every(
            (entry) => typeof entry === "string",
          ))
      )
        issues.push({
          path: `${path}.${field}`,
          message: "must be an array of targeting keys",
        });
    }
    if (segment.rules !== undefined) {
      if (!Array.isArray(segment.rules))
        issues.push({ path: `${path}.rules`, message: "must be an array" });
      else
        segment.rules.forEach((rule, index) =>
          validateExpression(
            rule,
            `${path}.rules[${index}]`,
            segmentIds,
            issues,
          ),
        );
    }
  }
  for (const [key, flag] of Object.entries(flags))
    validateFlag(flag, `$.flags.${key}`, flagIds, segmentIds, issues);

  // Client projection must remain evaluable without leaking server-only dependencies.
  for (const [key, rawFlag] of Object.entries(flags)) {
    if (!isRecord(rawFlag) || rawFlag.visibility !== "client") continue;
    const prerequisites = Array.isArray(rawFlag.prerequisites)
      ? rawFlag.prerequisites
      : [];
    for (const prerequisite of prerequisites) {
      if (isRecord(prerequisite) && typeof prerequisite.flag === "string") {
        const dependency = flags[prerequisite.flag];
        if (isRecord(dependency) && dependency.visibility !== "client")
          issues.push({
            path: `$.flags.${key}.prerequisites`,
            message: `client flag references server flag ${prerequisite.flag}`,
          });
      }
    }
    const rules = Array.isArray(rawFlag.rules) ? rawFlag.rules : [];
    for (const rule of rules) {
      if (!isRecord(rule)) continue;
      for (const segmentId of referencedSegments(
        rule.when as TargetingExpression,
      )) {
        const segment = segments[segmentId];
        if (isRecord(segment) && segment.visibility !== "client")
          issues.push({
            path: `$.flags.${key}.rules`,
            message: `client flag references server segment ${segmentId}`,
          });
      }
    }
  }

  for (const [key, rawSegment] of Object.entries(segments)) {
    if (!isRecord(rawSegment) || rawSegment.visibility !== "client") continue;
    const rules = Array.isArray(rawSegment.rules) ? rawSegment.rules : [];
    for (const rule of rules) {
      if (!isRecord(rule)) continue;
      for (const segmentId of referencedSegments(rule as TargetingExpression)) {
        const dependency = segments[segmentId];
        if (isRecord(dependency) && dependency.visibility !== "client")
          issues.push({
            path: `$.segments.${key}.rules`,
            message: `client segment references server segment ${segmentId}`,
          });
      }
    }
  }

  for (const [key, rawFlag] of Object.entries(flags)) {
    if (!isRecord(rawFlag) || !Array.isArray(rawFlag.prerequisites)) continue;
    for (const prerequisite of rawFlag.prerequisites) {
      if (!isRecord(prerequisite) || typeof prerequisite.flag !== "string")
        continue;
      const dependency = flags[prerequisite.flag];
      if (!isRecord(dependency) || !isRecord(dependency.variations)) continue;
      const dependencyVariations = dependency.variations;
      if (!Array.isArray(prerequisite.variations)) continue;
      prerequisite.variations.forEach((variation, index) => {
        if (
          typeof variation === "string" &&
          !(variation in dependencyVariations)
        )
          issues.push({
            path: `$.flags.${key}.prerequisites.${prerequisite.flag}.variations[${index}]`,
            message: "must reference a variation on the prerequisite flag",
          });
      });
    }
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, value: input as unknown as FlagConfig };
}

export function parseConfig(input: unknown): FlagConfig {
  const result = validateConfig(input);
  if (result.success) return result.value;
  throw new TypeError(
    `Invalid Superflag config:\n${result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`,
  );
}

export const schema = Object.freeze({
  version: SCHEMA_VERSION,
  parse: parseConfig,
  safeParse: validateConfig,
});
