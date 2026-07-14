import type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationOptions,
  Evaluator,
  FlagConfig,
  FlagKey,
  FlagValueFor,
} from "./types.js";

export interface TypedClient<C extends FlagConfig> {
  get<K extends FlagKey<C>>(
    flagKey: K,
    fallback: FlagValueFor<C, K>,
    options?: EvaluationOptions,
  ): FlagValueFor<C, K>;
  details<K extends FlagKey<C>>(
    flagKey: K,
    fallback: FlagValueFor<C, K>,
    options?: EvaluationOptions,
  ): EvaluationDetails<FlagValueFor<C, K>>;
  setContext(context: EvaluationContext): void;
  getContext(): EvaluationContext;
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
}

/** Framework-neutral external store used by React, React Native, Node, and CLI wrappers. */
export function createTypedClient<C extends FlagConfig>(
  evaluator: Evaluator<C>,
  initialContext: EvaluationContext,
): TypedClient<C> {
  let context = initialContext;
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    get(flagKey, fallback, options) {
      return evaluator.evaluate(flagKey, context, fallback, options).value;
    },
    details(flagKey, fallback, options) {
      return evaluator.evaluate(flagKey, context, fallback, options);
    },
    setContext(nextContext) {
      context = nextContext;
      revision += 1;
      for (const listener of listeners) listener();
    },
    getContext: () => context,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => revision,
  };
}
