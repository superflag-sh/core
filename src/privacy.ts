import { createEvaluator } from "./evaluator.js";
import { parseConfig } from "./schema.js";
import type {
  AttributeValue,
  EvaluationContext,
  EvaluationDetails,
  EvaluationOptions,
  Flag,
  FlagConfig,
  FlagValue,
  Rollout,
  Schedule,
  Segment,
  Serve,
  TargetingExpression,
  TargetingRule,
} from "./types.js";

export interface ClientProjectionOptions {
  /** Config metadata is omitted by default because it can contain internal data. */
  includeMetadata?: boolean;
}

const projectSchedule = (schedule: Schedule): Schedule => ({
  ...(schedule.start !== undefined ? { start: schedule.start } : {}),
  ...(schedule.end !== undefined ? { end: schedule.end } : {}),
});

function projectExpression(
  expression: TargetingExpression,
): TargetingExpression {
  if (expression.op === "all" || expression.op === "any")
    return {
      op: expression.op,
      expressions: expression.expressions.map(projectExpression),
    };
  if (expression.op === "not")
    return { op: "not", expression: projectExpression(expression.expression) };
  if (expression.op === "segment")
    return {
      op: "segment",
      segment: expression.segment,
      ...(expression.negate !== undefined ? { negate: expression.negate } : {}),
    };
  return {
    op: "match",
    attribute: expression.attribute,
    operator: expression.operator,
    ...(expression.value !== undefined ? { value: expression.value } : {}),
  };
}

const projectRollout = (rollout: Rollout): Rollout => ({
  variations: rollout.variations.map(({ variation, weight }) => ({
    variation,
    weight,
  })),
  ...(rollout.bucketBy !== undefined ? { bucketBy: rollout.bucketBy } : {}),
  ...(rollout.salt !== undefined ? { salt: rollout.salt } : {}),
});

function projectServe(serve: Serve): Serve {
  if ("variation" in serve) return { variation: serve.variation };
  if ("rollout" in serve) return { rollout: projectRollout(serve.rollout) };
  return {
    progressive: {
      start: serve.progressive.start,
      end: serve.progressive.end,
      from: projectRollout(serve.progressive.from),
      to: projectRollout(serve.progressive.to),
    },
  };
}

const projectRule = (rule: TargetingRule): TargetingRule => ({
  id: rule.id,
  when: projectExpression(rule.when),
  serve: projectServe(rule.serve),
  ...(rule.schedule ? { schedule: projectSchedule(rule.schedule) } : {}),
  ...(rule.description !== undefined ? { description: rule.description } : {}),
});

function projectFlag(flag: Flag, includeMetadata: boolean): Flag {
  return {
    type: flag.type,
    description: flag.description,
    tags: [...flag.tags],
    owner: flag.owner,
    lifecycle: flag.lifecycle,
    enabled: flag.enabled,
    variations: Object.fromEntries(
      Object.entries(flag.variations).map(([key, variation]) => [
        key,
        {
          value: variation.value,
          ...(variation.name !== undefined ? { name: variation.name } : {}),
          ...(variation.description !== undefined
            ? { description: variation.description }
            : {}),
        },
      ]),
    ),
    offVariation: flag.offVariation,
    fallthrough: projectServe(flag.fallthrough),
    ...(flag.prerequisites
      ? {
          prerequisites: flag.prerequisites.map(({ flag, variations }) => ({
            flag,
            variations: [...variations],
          })),
        }
      : {}),
    ...(flag.rules ? { rules: flag.rules.map(projectRule) } : {}),
    ...(flag.schedule ? { schedule: projectSchedule(flag.schedule) } : {}),
    ...(flag.visibility !== undefined ? { visibility: flag.visibility } : {}),
    ...(includeMetadata && flag.metadata ? { metadata: flag.metadata } : {}),
  };
}

const projectSegment = (segment: Segment): Segment => ({
  ...(segment.included ? { included: [...segment.included] } : {}),
  ...(segment.excluded ? { excluded: [...segment.excluded] } : {}),
  ...(segment.rules ? { rules: segment.rules.map(projectExpression) } : {}),
  ...(segment.schedule ? { schedule: projectSchedule(segment.schedule) } : {}),
  ...(segment.visibility !== undefined
    ? { visibility: segment.visibility }
    : {}),
  ...(segment.description !== undefined
    ? { description: segment.description }
    : {}),
});

/**
 * Produces an evaluable client bundle containing only explicitly client-visible
 * flags and segments. Validation rejects any client flag with a private dependency.
 */
export function projectClientConfig(
  config: FlagConfig,
  options: ClientProjectionOptions = {},
): FlagConfig {
  const parsed = parseConfig(config);
  const flags = Object.fromEntries(
    Object.entries(parsed.flags)
      .filter(([, flag]) => flag.visibility === "client")
      .map(([key, flag]) => [
        key,
        projectFlag(flag, options.includeMetadata === true),
      ]),
  );
  const segments = Object.fromEntries(
    Object.entries(parsed.segments ?? {})
      .filter(([, segment]) => segment.visibility === "client")
      .map(([key, segment]) => [key, projectSegment(segment)]),
  );
  return {
    schemaVersion: parsed.schemaVersion,
    source: parsed.source,
    configVersion: parsed.configVersion,
    flags,
    ...(Object.keys(segments).length > 0 ? { segments } : {}),
    ...(options.includeMetadata && parsed.metadata
      ? { metadata: parsed.metadata }
      : {}),
  };
}

/** Only copies an explicit allow-list of attributes into browser/device state. */
export function sanitizeContext(
  context: EvaluationContext,
  allowedAttributes: readonly string[] = [],
): EvaluationContext {
  const attributes: Record<string, AttributeValue> = {};
  for (const key of allowedAttributes) {
    const value = context.attributes?.[key];
    if (value !== undefined) attributes[key] = value;
  }
  return {
    targetingKey: context.targetingKey,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

export interface ClientSnapshot {
  schemaVersion: 1;
  source: FlagConfig["source"];
  configVersion: number;
  evaluatedAt: string;
  flags: Readonly<
    Record<
      string,
      Pick<
        EvaluationDetails,
        | "flagKey"
        | "source"
        | "configVersion"
        | "value"
        | "variation"
        | "reason"
        | "ruleId"
        | "errorCode"
        | "errorMessage"
        | "timestamp"
      >
    >
  >;
}

/**
 * Safest client delivery mode: evaluate on the server and send values/details,
 * never rules, segment membership, or context attributes.
 */
export function createClientSnapshot(
  config: FlagConfig,
  context: EvaluationContext,
  fallbacks: Readonly<Record<string, FlagValue>>,
  options?: EvaluationOptions,
): ClientSnapshot {
  const projected = projectClientConfig(config);
  const evaluator = createEvaluator(projected);
  const flags = Object.fromEntries(
    Object.keys(projected.flags).map((flagKey) => {
      const fallback =
        fallbacks[flagKey] ??
        projected.flags[flagKey]?.variations[
          projected.flags[flagKey]?.offVariation ?? ""
        ]?.value;
      if (fallback === undefined)
        throw new TypeError(`A fallback is required for ${flagKey}`);
      const details = evaluator.evaluate(flagKey, context, fallback, options);
      return [
        flagKey,
        {
          flagKey: details.flagKey,
          source: details.source,
          configVersion: details.configVersion,
          value: details.value,
          variation: details.variation,
          reason: details.reason,
          ruleId: details.ruleId,
          errorCode: details.errorCode,
          errorMessage: details.errorMessage,
          timestamp: details.timestamp,
        },
      ];
    }),
  );
  const evaluatedAt =
    options?.now === undefined
      ? new Date().toISOString()
      : new Date(options.now).toISOString();
  return {
    schemaVersion: 1,
    source: projected.source,
    configVersion: projected.configVersion,
    evaluatedAt,
    flags,
  };
}
