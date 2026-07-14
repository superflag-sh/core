import { type GenerateTypesOptions, generateTypes } from "./codegen";
import { createEvaluator } from "./evaluator";
import { parseConfig, validateConfig } from "./schema";
import type { EvaluationContext, EvaluationOptions, FlagValue } from "./types";

export function validateConfigText(text: string) {
  try {
    return validateConfig(JSON.parse(text));
  } catch (error) {
    return {
      success: false as const,
      issues: [
        {
          path: "$",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export function generateTypesFromText(
  text: string,
  options?: GenerateTypesOptions,
): string {
  return generateTypes(parseConfig(JSON.parse(text)), options);
}

export function evaluateFromText(
  text: string,
  flagKey: string,
  context: EvaluationContext,
  fallback: FlagValue,
  options?: EvaluationOptions,
) {
  return createEvaluator(parseConfig(JSON.parse(text))).evaluate(
    flagKey,
    context,
    fallback,
    options,
  );
}
