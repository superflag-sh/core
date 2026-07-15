import {
  type ExperimentEventReference,
  type ExposureEvent,
  exposureDedupeKey,
  FEATURE_EVENT_SCHEMA_VERSION,
  type FeatureEvent,
  type FeatureEventDimension,
  type FeatureEventSdk,
  type OutcomeEvent,
  type PseudonymousSubject,
  parseFeatureEvent,
} from "./events.js";
import type { ConfigSource, EvaluationReason } from "./types.js";

export type TelemetryItemResult =
  | { eventId: string; status: "accepted" | "duplicate" }
  | {
      eventId: string;
      status: "permanent_error";
      code: string;
      message?: string;
    }
  | {
      eventId: string;
      status: "retryable_error";
      code?: string;
      retryAfterMs?: number;
    };

export interface TelemetryBatchResult {
  items: readonly TelemetryItemResult[];
}

export interface TelemetryTransport {
  send(
    events: readonly FeatureEvent[],
    options: { signal: AbortSignal },
  ): Promise<TelemetryBatchResult>;
}

export type TelemetryBackpressurePolicy = "drop-oldest" | "drop-newest";

export type TelemetryDiagnosticCode =
  | "callback_error"
  | "duplicate_exposure"
  | "event_id_conflict"
  | "invalid_event"
  | "invalid_response"
  | "permanent_rejection"
  | "queue_overflow"
  | "retry_exhausted"
  | "retry_scheduled"
  | "shutdown_drop"
  | "shutdown_timeout"
  | "transport_error";

/** Diagnostics are callbacks only. They are never converted into feature events. */
export interface TelemetryDiagnostic {
  code: TelemetryDiagnosticCode;
  message: string;
  queueSize: number;
  eventId?: string;
  retryInMs?: number;
}

export interface TelemetryScheduler {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TelemetryAdapterOptions {
  /** Omit for disabled or callback-only operation. No hosted transport is implied. */
  transport?: TelemetryTransport;
  /** Existing SDK callback seam. It is invoked synchronously and never awaited. */
  onEvent?: (event: FeatureEvent) => void;
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void;
  maxQueueSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  backpressure?: TelemetryBackpressurePolicy;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  retryJitterRatio?: number;
  maxExposureDedupeEntries?: number;
  /** Canonical event dimensions accepted by direct enqueue calls. Defaults closed. */
  allowedDimensions?: readonly string[];
  maxEventPayloadBytes?: number;
  /** Overall best-effort final-drain deadline. Defaults to 5 seconds. */
  shutdownTimeoutMs?: number;
  scheduler?: TelemetryScheduler;
}

export type TelemetryEnqueueResult =
  | { status: "queued"; queueSize: number }
  | { status: "callback_only"; queueSize: 0 }
  | { status: "disabled"; queueSize: 0 }
  | { status: "duplicate"; queueSize: number }
  | {
      status: "dropped";
      reason:
        | "callback_error"
        | "closed"
        | "diagnostic_recursion"
        | "event_id_conflict"
        | "invalid_event"
        | "queue_overflow";
      queueSize: number;
    };

export interface TelemetryFlushResult {
  sent: number;
  accepted: number;
  duplicates: number;
  permanent: number;
  retryScheduled: number;
  queueSize: number;
}

export interface TelemetryShutdownResult extends TelemetryFlushResult {
  timedOut: boolean;
  dropped: number;
}

export interface TelemetrySnapshot {
  mode: "disabled" | "callback" | "transport" | "callback+transport";
  queueSize: number;
  inFlight: boolean;
  closing: boolean;
  closed: boolean;
  rememberedExposures: number;
  nextFlushAt?: number;
}

export interface NumericFeatureOutcomeInput {
  id: string;
  source: ConfigSource;
  flagKey: string;
  variation: string;
  configVersion: number;
  reason: EvaluationReason;
  timestamp: string;
  sdk: FeatureEventSdk;
  subject: PseudonymousSubject;
  exposureId: string;
  metric: { key: string; revision: number };
  value: number;
  experiment?: ExperimentEventReference;
  /** Bounded attributes copied only when their keys are explicitly allowed. */
  attributes?: Readonly<Record<string, FeatureEventDimension>>;
  allowedAttributes?: readonly string[];
}

export interface TelemetryAdapter {
  enqueue(event: FeatureEvent): TelemetryEnqueueResult;
  /** Explicit, feature-scoped numeric outcome helper; not a generic event API. */
  trackNumeric(input: NumericFeatureOutcomeInput): TelemetryEnqueueResult;
  flush(): Promise<TelemetryFlushResult>;
  /**
   * Stops admission immediately. By default it aborts an existing flush, then
   * force-attempts queued and delayed retries until accepted, permanent, retry
   * budget exhausted, or the overall deadline expires.
   */
  shutdown(options?: {
    flush?: boolean;
    timeoutMs?: number;
  }): Promise<TelemetryShutdownResult>;
  getSnapshot(): TelemetrySnapshot;
}

interface QueueEntry {
  event: FeatureEvent;
  attempts: number;
  readyAt: number;
  payload: string;
  exposureKey?: string;
  callbackDelivered: boolean;
}

const defaultScheduler: TelemetryScheduler = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const MAX_BATCH_SIZE = 100;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const positiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;

const nonNegative = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;

export function createNumericOutcomeEvent(
  input: NumericFeatureOutcomeInput,
): OutcomeEvent {
  if (!Number.isFinite(input.value))
    throw new TypeError("Numeric feature outcome value must be finite");
  return parseFeatureEvent(
    {
      schemaVersion: FEATURE_EVENT_SCHEMA_VERSION,
      id: input.id,
      kind: "outcome",
      source: input.source,
      flagKey: input.flagKey,
      variation: input.variation,
      configVersion: input.configVersion,
      reason: input.reason,
      timestamp: input.timestamp,
      sdk: input.sdk,
      subject: input.subject,
      exposureId: input.exposureId,
      metric: input.metric,
      value: input.value,
      ...(input.experiment ? { experiment: input.experiment } : {}),
      ...(input.attributes ? { dimensions: input.attributes } : {}),
    },
    input.allowedAttributes
      ? { allowedDimensions: input.allowedAttributes }
      : undefined,
  ) as OutcomeEvent;
}

/**
 * Creates an opt-in, dependency-light queue. Evaluation never imports or waits
 * on this adapter; enqueue is synchronous and all delivery is best effort.
 */
export function createTelemetryAdapter(
  options: TelemetryAdapterOptions = {},
): TelemetryAdapter {
  const transport = options.transport;
  const onEvent = options.onEvent;
  const onDiagnostic = options.onDiagnostic;
  const scheduler = options.scheduler ?? defaultScheduler;
  const maxQueueSize = positiveInteger(options.maxQueueSize, 1_000);
  const batchSize = Math.min(
    positiveInteger(options.batchSize, 50),
    maxQueueSize,
    MAX_BATCH_SIZE,
  );
  const flushIntervalMs = nonNegative(options.flushIntervalMs, 10_000);
  const backpressure = options.backpressure ?? "drop-oldest";
  const maxAttempts = positiveInteger(options.maxAttempts, 5);
  const retryBaseMs = nonNegative(options.retryBaseMs, 500);
  const retryMaxMs = Math.max(
    retryBaseMs,
    nonNegative(options.retryMaxMs, 30_000),
  );
  const retryJitterRatio = Math.min(
    1,
    nonNegative(options.retryJitterRatio, 0.2),
  );
  const maxExposureDedupeEntries = positiveInteger(
    options.maxExposureDedupeEntries,
    10_000,
  );
  const shutdownTimeoutMs = nonNegative(options.shutdownTimeoutMs, 5_000);
  const eventParserOptions = {
    ...(options.allowedDimensions
      ? { allowedDimensions: options.allowedDimensions }
      : {}),
    ...(options.maxEventPayloadBytes !== undefined
      ? { maxPayloadBytes: options.maxEventPayloadBytes }
      : {}),
  };

  const queue: QueueEntry[] = [];
  const activeEventIds = new Map<string, string>();
  const exposureKeys = new Set<string>();
  const exposureOrder: string[] = [];
  const shutdownDroppedEventIds = new Set<string>();
  let closing = false;
  let closed = false;
  let inDiagnostic = false;
  let flushPromise: Promise<TelemetryFlushResult> | undefined;
  let activeController: AbortController | undefined;
  let inFlightEntries: readonly QueueEntry[] = [];
  let shutdownPromise: Promise<TelemetryShutdownResult> | undefined;
  let timer: unknown;
  let timerDueAt: number | undefined;

  const emptyResult = (): TelemetryFlushResult => ({
    sent: 0,
    accepted: 0,
    duplicates: 0,
    permanent: 0,
    retryScheduled: 0,
    queueSize: queue.length,
  });

  const emptyShutdownResult = (): TelemetryShutdownResult => ({
    ...emptyResult(),
    timedOut: false,
    dropped: 0,
  });

  function emitDiagnostic(
    diagnostic: Omit<TelemetryDiagnostic, "queueSize">,
  ): void {
    if (!onDiagnostic || inDiagnostic) return;
    inDiagnostic = true;
    try {
      const returned = onDiagnostic({
        ...diagnostic,
        queueSize: queue.length,
      }) as unknown;
      if (
        typeof returned === "object" &&
        returned !== null &&
        "then" in returned &&
        typeof returned.then === "function"
      )
        void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // A diagnostic handler cannot generate another diagnostic or affect delivery.
    } finally {
      inDiagnostic = false;
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) scheduler.clearTimeout(timer);
    timer = undefined;
    timerDueAt = undefined;
  }

  function schedule(delayMs: number): void {
    if (closing || closed || !transport || queue.length === 0) return;
    const delay = Math.max(0, delayMs);
    const dueAt = scheduler.now() + delay;
    if (timer !== undefined && timerDueAt !== undefined && timerDueAt <= dueAt)
      return;
    clearTimer();
    timerDueAt = dueAt;
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      timerDueAt = undefined;
      void flush();
    }, delay);
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    )
      timer.unref();
  }

  function forgetEntry(entry: QueueEntry): void {
    if (activeEventIds.get(entry.event.id) === entry.payload)
      activeEventIds.delete(entry.event.id);
  }

  function forgetExposure(key: string | undefined): void {
    if (!key) return;
    exposureKeys.delete(key);
    const index = exposureOrder.indexOf(key);
    if (index >= 0) exposureOrder.splice(index, 1);
  }

  function forgetUndeliveredExposure(entry: QueueEntry): void {
    if (!entry.callbackDelivered) forgetExposure(entry.exposureKey);
  }

  function dropEntry(entry: QueueEntry, message: string): void {
    forgetEntry(entry);
    forgetUndeliveredExposure(entry);
    emitDiagnostic({
      code: "queue_overflow",
      message,
      eventId: entry.event.id,
    });
  }

  function appendEntry(entry: QueueEntry): boolean {
    if (queue.length >= maxQueueSize) {
      if (backpressure === "drop-newest") {
        dropEntry(entry, "Telemetry queue is full; newest event was dropped");
        return false;
      }
      const dropped = queue.shift();
      if (dropped)
        dropEntry(dropped, "Telemetry queue is full; oldest event was dropped");
    }
    queue.push(entry);
    activeEventIds.set(entry.event.id, entry.payload);
    schedule(queue.length >= batchSize ? 0 : flushIntervalMs);
    return true;
  }

  function rememberExposure(key: string): void {
    exposureKeys.add(key);
    exposureOrder.push(key);
    while (exposureOrder.length > maxExposureDedupeEntries) {
      const oldest = exposureOrder.shift();
      if (oldest) exposureKeys.delete(oldest);
    }
  }

  function invokeEventCallback(event: FeatureEvent): boolean {
    if (!onEvent) return false;
    try {
      const returned = onEvent(structuredClone(event)) as unknown;
      if (
        typeof returned === "object" &&
        returned !== null &&
        "then" in returned &&
        typeof returned.then === "function"
      ) {
        // Observe accidental promises so an async rejection can never escape.
        void Promise.resolve(returned).catch(() => undefined);
        emitDiagnostic({
          code: "callback_error",
          message: "Telemetry event callbacks must be synchronous",
          eventId: event.id,
        });
        return false;
      }
      return true;
    } catch {
      emitDiagnostic({
        code: "callback_error",
        message: "Telemetry event callback threw",
        eventId: event.id,
      });
      return false;
    }
  }

  function enqueueWithDimensions(
    input: FeatureEvent,
    allowedDimensions?: readonly string[],
  ): TelemetryEnqueueResult {
    if (inDiagnostic)
      return {
        status: "dropped",
        reason: "diagnostic_recursion",
        queueSize: queue.length,
      };
    if (closing || closed)
      return { status: "dropped", reason: "closed", queueSize: queue.length };

    let event: FeatureEvent;
    try {
      event = deepFreeze(
        parseFeatureEvent(input, {
          ...eventParserOptions,
          ...(allowedDimensions ? { allowedDimensions } : {}),
        }),
      );
    } catch {
      const eventId =
        typeof input === "object" && input !== null && "id" in input
          ? String(input.id)
          : undefined;
      emitDiagnostic({
        code: "invalid_event",
        message: "Telemetry event failed canonical validation",
        ...(eventId !== undefined ? { eventId } : {}),
      });
      return {
        status: "dropped",
        reason: "invalid_event",
        queueSize: queue.length,
      };
    }

    const payload = JSON.stringify(event);
    const activePayload = activeEventIds.get(event.id);
    if (activePayload !== undefined) {
      if (activePayload === payload)
        return { status: "duplicate", queueSize: queue.length };
      emitDiagnostic({
        code: "event_id_conflict",
        message: "A queued event id was reused with a different payload",
        eventId: event.id,
      });
      return {
        status: "dropped",
        reason: "event_id_conflict",
        queueSize: queue.length,
      };
    }

    const exposureKey =
      event.kind === "exposure"
        ? exposureDedupeKey(event as ExposureEvent)
        : undefined;
    if (exposureKey && exposureKeys.has(exposureKey)) {
      emitDiagnostic({
        code: "duplicate_exposure",
        message: "Exposure was already emitted for this iteration and subject",
        eventId: event.id,
      });
      return { status: "duplicate", queueSize: queue.length };
    }

    const callbackDelivered = invokeEventCallback(event);
    if (!transport) {
      if (callbackDelivered) {
        if (exposureKey) rememberExposure(exposureKey);
        return { status: "callback_only", queueSize: 0 };
      }
      return onEvent
        ? { status: "dropped", reason: "callback_error", queueSize: 0 }
        : { status: "disabled", queueSize: 0 };
    }

    const queued = appendEntry({
      event,
      attempts: 0,
      readyAt: scheduler.now(),
      payload,
      ...(exposureKey ? { exposureKey } : {}),
      callbackDelivered,
    });
    if (queued || callbackDelivered) {
      if (exposureKey) rememberExposure(exposureKey);
    }
    return queued
      ? { status: "queued", queueSize: queue.length }
      : {
          status: "dropped",
          reason: "queue_overflow",
          queueSize: queue.length,
        };
  }

  function enqueue(event: FeatureEvent): TelemetryEnqueueResult {
    return enqueueWithDimensions(event);
  }

  function retryDelay(attempt: number, retryAfterMs?: number): number {
    const exponential = Math.min(
      retryMaxMs,
      retryBaseMs * 2 ** Math.max(0, attempt - 1),
    );
    const rawRandom = scheduler.random();
    const random = Number.isFinite(rawRandom)
      ? Math.min(1, Math.max(0, rawRandom))
      : 0.5;
    const jitter = exponential * retryJitterRatio * (random * 2 - 1);
    const retryAfter =
      typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs >= 0
        ? Math.min(retryMaxMs, retryAfterMs)
        : 0;
    return Math.min(
      retryMaxMs,
      Math.max(retryAfter, Math.max(0, Math.round(exponential + jitter))),
    );
  }

  function scheduleRetry(
    entry: QueueEntry,
    result: TelemetryFlushResult,
    retryAfterMs?: number,
  ): void {
    entry.attempts++;
    if (closed || entry.attempts >= maxAttempts) {
      forgetEntry(entry);
      forgetUndeliveredExposure(entry);
      result.permanent++;
      emitDiagnostic({
        code: "retry_exhausted",
        message: "Telemetry event exhausted its retry budget",
        eventId: entry.event.id,
      });
      return;
    }
    if (
      retryAfterMs !== undefined &&
      (typeof retryAfterMs !== "number" ||
        !Number.isFinite(retryAfterMs) ||
        retryAfterMs < 0)
    )
      emitDiagnostic({
        code: "invalid_response",
        message: "Transport returned an invalid retryAfterMs",
        eventId: entry.event.id,
      });
    const delay = retryDelay(entry.attempts, retryAfterMs);
    entry.readyAt = scheduler.now() + delay;
    if (appendEntry(entry)) {
      result.retryScheduled++;
      emitDiagnostic({
        code: "retry_scheduled",
        message: "Telemetry event was scheduled for retry",
        eventId: entry.event.id,
        retryInMs: delay,
      });
    } else result.permanent++;
  }

  function nextEligibleBatch(limit: number): QueueEntry[] {
    const now = scheduler.now();
    const selected: QueueEntry[] = [];
    for (
      let index = 0;
      index < queue.length && selected.length < Math.min(batchSize, limit);
    ) {
      const entry = queue[index];
      if (entry && entry.readyAt <= now) {
        selected.push(entry);
        queue.splice(index, 1);
      } else index++;
    }
    return selected;
  }

  function schedulePending(): void {
    if (closing || closed || !transport || queue.length === 0) return;
    const nextReadyAt = Math.min(...queue.map((entry) => entry.readyAt));
    const retryWait = nextReadyAt - scheduler.now();
    if (retryWait > 0) schedule(retryWait);
    else schedule(queue.length >= batchSize ? 0 : flushIntervalMs);
  }

  async function performBatch(limit: number): Promise<TelemetryFlushResult> {
    clearTimer();
    if (!transport) return emptyResult();
    const entries = nextEligibleBatch(limit);
    if (entries.length === 0) {
      schedulePending();
      return emptyResult();
    }
    const result: TelemetryFlushResult = {
      sent: entries.length,
      accepted: 0,
      duplicates: 0,
      permanent: 0,
      retryScheduled: 0,
      queueSize: queue.length,
    };
    const controller = new AbortController();
    activeController = controller;
    inFlightEntries = entries;
    let removeAbortListener: (() => void) | undefined;
    try {
      const delivery = Promise.resolve().then(() =>
        transport.send(
          entries.map((entry) => entry.event),
          { signal: controller.signal },
        ),
      );
      // A transport may ignore AbortSignal. Keep observing its eventual
      // rejection, but release this batch's ownership as soon as the signal is
      // aborted so flush/shutdown cannot remain pending forever.
      void delivery.catch(() => undefined);
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error("Telemetry delivery aborted"));
        if (controller.signal.aborted) onAbort();
        else {
          controller.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            controller.signal.removeEventListener("abort", onAbort);
        }
      });
      const response = await Promise.race([delivery, aborted]);
      const responseById = new Map<string, TelemetryItemResult>();
      for (const item of response.items ?? []) {
        if (!entries.some((entry) => entry.event.id === item.eventId)) {
          emitDiagnostic({
            code: "invalid_response",
            message: "Transport returned a result for an unknown event id",
            eventId: item.eventId,
          });
          continue;
        }
        if (responseById.has(item.eventId)) {
          emitDiagnostic({
            code: "invalid_response",
            message: "Transport returned duplicate results for an event id",
            eventId: item.eventId,
          });
          continue;
        }
        responseById.set(item.eventId, item);
      }
      for (const entry of entries) {
        const item = responseById.get(entry.event.id);
        if (!item || item.status === "retryable_error") {
          scheduleRetry(entry, result, item?.retryAfterMs);
        } else if (item.status === "accepted") {
          forgetEntry(entry);
          result.accepted++;
        } else if (item.status === "duplicate") {
          forgetEntry(entry);
          result.duplicates++;
        } else if (item.status === "permanent_error") {
          forgetEntry(entry);
          forgetUndeliveredExposure(entry);
          result.permanent++;
          emitDiagnostic({
            code: "permanent_rejection",
            message: `Telemetry event was permanently rejected: ${item.code}`,
            eventId: entry.event.id,
          });
        } else {
          scheduleRetry(entry, result);
        }
      }
    } catch {
      if (closing && controller.signal.aborted) {
        for (const entry of entries) {
          forgetEntry(entry);
          forgetUndeliveredExposure(entry);
          shutdownDroppedEventIds.add(entry.event.id);
          emitDiagnostic({
            code: "shutdown_drop",
            message: "In-flight telemetry was aborted during shutdown",
            eventId: entry.event.id,
          });
        }
      } else {
        emitDiagnostic({
          code: "transport_error",
          message: "Telemetry transport failed",
        });
        for (const entry of entries) scheduleRetry(entry, result);
      }
    } finally {
      removeAbortListener?.();
      if (activeController === controller) activeController = undefined;
      if (inFlightEntries === entries) inFlightEntries = [];
      result.queueSize = queue.length;
      schedulePending();
    }
    return result;
  }

  async function performFlush(): Promise<TelemetryFlushResult> {
    const aggregate = emptyResult();
    let remaining = queue.filter(
      (entry) => entry.readyAt <= scheduler.now(),
    ).length;
    if (remaining === 0) {
      schedulePending();
      return aggregate;
    }
    while (remaining > 0) {
      const batch = await performBatch(remaining);
      aggregate.sent += batch.sent;
      aggregate.accepted += batch.accepted;
      aggregate.duplicates += batch.duplicates;
      aggregate.permanent += batch.permanent;
      aggregate.retryScheduled += batch.retryScheduled;
      aggregate.queueSize = batch.queueSize;
      if (batch.sent === 0) break;
      remaining -= batch.sent;
      if (closing) break;
    }
    return aggregate;
  }

  function flush(): Promise<TelemetryFlushResult> {
    if (flushPromise) return flushPromise;
    if (closing || closed) return Promise.resolve(emptyResult());
    flushPromise = performFlush().finally(() => {
      flushPromise = undefined;
    });
    return flushPromise;
  }

  function addFlushResult(
    target: TelemetryShutdownResult,
    source: TelemetryFlushResult,
  ): void {
    target.sent += source.sent;
    target.accepted += source.accepted;
    target.duplicates += source.duplicates;
    target.permanent += source.permanent;
    target.retryScheduled += source.retryScheduled;
    target.queueSize = source.queueSize;
  }

  async function performShutdown(shutdownOptions: {
    flush?: boolean;
    timeoutMs?: number;
  }): Promise<TelemetryShutdownResult> {
    if (closed) return emptyShutdownResult();
    shutdownDroppedEventIds.clear();
    closing = true;
    clearTimer();
    const result = emptyShutdownResult();
    const shouldFlush = shutdownOptions.flush !== false;
    const timeoutMs = nonNegative(shutdownOptions.timeoutMs, shutdownTimeoutMs);
    let timeoutHandle: unknown;
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = scheduler.setTimeout(() => resolve("timeout"), timeoutMs);
    });

    async function beforeDeadline<T>(
      promise: Promise<T>,
    ): Promise<{ completed: true; value: T } | { completed: false }> {
      const outcome = await Promise.race([
        promise.then((value) => ({ completed: true as const, value })),
        timeout.then(() => ({ completed: false as const })),
      ]);
      if (!outcome.completed) timedOut = true;
      return outcome;
    }

    try {
      if (!shouldFlush) {
        activeController?.abort();
      } else {
        if (flushPromise) {
          activeController?.abort();
          const existing = await beforeDeadline(flushPromise);
          if (existing.completed) addFlushResult(result, existing.value);
        }

        while (!timedOut && queue.length > 0) {
          // Final drain deliberately ignores prior backoff deadlines. Attempt
          // every retained event now, while preserving event ids and budgets.
          for (const entry of queue) entry.readyAt = scheduler.now();
          const batch = await beforeDeadline(performBatch(queue.length));
          if (!batch.completed) {
            activeController?.abort();
            break;
          }
          addFlushResult(result, batch.value);
          if (batch.value.sent === 0) break;
        }
      }
    } finally {
      if (timeoutHandle !== undefined) scheduler.clearTimeout(timeoutHandle);
      if (timedOut) {
        result.timedOut = true;
        activeController?.abort();
        emitDiagnostic({
          code: "shutdown_timeout",
          message: "Telemetry final drain exceeded its shutdown deadline",
        });
      }

      const abandoned = new Map<string, QueueEntry>();
      for (const entry of queue.splice(0)) abandoned.set(entry.event.id, entry);
      if (timedOut || !shouldFlush)
        for (const entry of inFlightEntries)
          abandoned.set(entry.event.id, entry);
      for (const entry of abandoned.values()) {
        forgetEntry(entry);
        forgetUndeliveredExposure(entry);
        shutdownDroppedEventIds.add(entry.event.id);
        emitDiagnostic({
          code: "shutdown_drop",
          message: "Telemetry event remained undelivered at shutdown",
          eventId: entry.event.id,
        });
      }
      result.dropped = shutdownDroppedEventIds.size;
      result.queueSize = 0;
      closed = true;
      clearTimer();
    }
    return result;
  }

  function shutdown(
    shutdownOptions: { flush?: boolean; timeoutMs?: number } = {},
  ): Promise<TelemetryShutdownResult> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = performShutdown(shutdownOptions);
    return shutdownPromise;
  }

  function getSnapshot(): TelemetrySnapshot {
    const mode = transport
      ? onEvent
        ? "callback+transport"
        : "transport"
      : onEvent
        ? "callback"
        : "disabled";
    return {
      mode,
      queueSize: queue.length,
      inFlight: flushPromise !== undefined,
      closing,
      closed,
      rememberedExposures: exposureKeys.size,
      ...(timerDueAt !== undefined ? { nextFlushAt: timerDueAt } : {}),
    };
  }

  return {
    enqueue,
    trackNumeric(input) {
      return enqueueWithDimensions(
        createNumericOutcomeEvent(input),
        input.allowedAttributes,
      );
    },
    flush,
    shutdown,
    getSnapshot,
  };
}
