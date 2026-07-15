import { describe, expect, test } from "bun:test";
import type { FeatureEvent } from "../src/events";
import {
  createNumericOutcomeEvent,
  createTelemetryAdapter,
  type TelemetryAdapter,
  type TelemetryDiagnostic,
  type TelemetryScheduler,
  type TelemetryTransport,
} from "../src/telemetry";

function featureEvent(
  id: string,
  overrides: Partial<FeatureEvent> = {},
): FeatureEvent {
  return {
    schemaVersion: 1,
    id,
    kind: "decision",
    source: { app: "telemetry-tests", environment: "test" },
    flagKey: "checkout",
    variation: "treatment",
    configVersion: 11,
    reason: "SPLIT",
    timestamp: "2030-01-01T00:00:00.000Z",
    sdk: { name: "core-tests", version: "1.0.0", platform: "node" },
    subject: {
      id: "psn_0123456789abcdef",
      namespace: "telemetry-tests",
      revision: 1,
      state: "authenticated",
    },
    ...overrides,
  } as FeatureEvent;
}

class FakeScheduler implements TelemetryScheduler {
  time = 1_000;
  timers = new Map<number, { callback: () => void; at: number }>();
  nextTimer = 1;

  now(): number {
    return this.time;
  }

  random(): number {
    return 0.5;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextTimer++;
    this.timers.set(id, { callback, at: this.time + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
  }

  runDue(): void {
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.time)
      .sort(([, left], [, right]) => left.at - right.at);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
    }
  }
}

describe("telemetry adapter", () => {
  test("is disabled without callbacks or an explicit transport", () => {
    const adapter = createTelemetryAdapter();
    expect(adapter.getSnapshot()).toMatchObject({
      mode: "disabled",
      queueSize: 0,
    });
    expect(adapter.enqueue(featureEvent("evt-disabled"))).toEqual({
      status: "disabled",
      queueSize: 0,
    });
  });

  test("supports callback-only operation without retaining a queue", () => {
    const events: FeatureEvent[] = [];
    const adapter = createTelemetryAdapter({
      onEvent: (event) => events.push(event),
    });
    expect(adapter.enqueue(featureEvent("evt-callback"))).toEqual({
      status: "callback_only",
      queueSize: 0,
    });
    expect(events.map((event) => event.id)).toEqual(["evt-callback"]);
    expect(adapter.getSnapshot()).toMatchObject({
      mode: "callback",
      queueSize: 0,
    });
  });

  test("projects direct enqueue calls through the canonical runtime boundary", () => {
    const events: FeatureEvent[] = [];
    const adapter = createTelemetryAdapter({
      onEvent: (event) => events.push(event),
    });
    expect(
      adapter.enqueue({
        ...featureEvent("evt-projected"),
        targetingKey: "must-not-survive",
        clientKey: "must-not-survive",
      } as unknown as FeatureEvent),
    ).toMatchObject({ status: "callback_only" });
    expect(JSON.stringify(events[0])).not.toContain("must-not-survive");
    expect(
      adapter.enqueue({
        ...featureEvent("evt-invalid"),
        subject: { id: "raw-user-id" },
      } as unknown as FeatureEvent),
    ).toMatchObject({ status: "dropped", reason: "invalid_event" });
  });

  test("isolates callback mutation from queued transport events", async () => {
    let sent: FeatureEvent | undefined;
    const adapter = createTelemetryAdapter({
      onEvent(event) {
        event.variation = "callback-mutated";
      },
      transport: {
        async send(events) {
          sent = events[0];
          return {
            items: events.map((event) => ({
              eventId: event.id,
              status: "accepted" as const,
            })),
          };
        },
      },
      scheduler: new FakeScheduler(),
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-callback-isolation"));
    await adapter.flush();
    expect(sent?.variation).toBe("treatment");
    expect(Object.isFrozen(sent)).toBeTrue();
  });

  test("batches without exceeding the configured batch size", async () => {
    const batches: string[][] = [];
    const transport: TelemetryTransport = {
      async send(events) {
        batches.push(events.map((event) => event.id));
        return {
          items: events.map((event) => ({
            eventId: event.id,
            status: "accepted" as const,
          })),
        };
      },
    };
    const adapter = createTelemetryAdapter({
      transport,
      batchSize: 2,
      flushIntervalMs: 60_000,
      scheduler: new FakeScheduler(),
    });
    adapter.enqueue(featureEvent("evt-batch-1"));
    adapter.enqueue(featureEvent("evt-batch-2"));
    adapter.enqueue(featureEvent("evt-batch-3"));
    expect(await adapter.flush()).toMatchObject({
      sent: 3,
      accepted: 3,
      queueSize: 0,
    });
    expect(batches).toEqual([["evt-batch-1", "evt-batch-2"], ["evt-batch-3"]]);
  });

  test("applies bounded drop-oldest and drop-newest backpressure", async () => {
    const sentOldest: string[] = [];
    const accept = (sent: string[]): TelemetryTransport => ({
      async send(events) {
        sent.push(...events.map((event) => event.id));
        return {
          items: events.map((event) => ({
            eventId: event.id,
            status: "accepted" as const,
          })),
        };
      },
    });
    const oldest = createTelemetryAdapter({
      transport: accept(sentOldest),
      maxQueueSize: 2,
      batchSize: 2,
      flushIntervalMs: 60_000,
      scheduler: new FakeScheduler(),
      backpressure: "drop-oldest",
    });
    oldest.enqueue(featureEvent("evt-oldest-1"));
    oldest.enqueue(featureEvent("evt-oldest-2"));
    expect(oldest.enqueue(featureEvent("evt-oldest-3"))).toMatchObject({
      status: "queued",
      queueSize: 2,
    });
    await oldest.flush();
    expect(sentOldest).toEqual(["evt-oldest-2", "evt-oldest-3"]);

    const sentNewest: string[] = [];
    const newest = createTelemetryAdapter({
      transport: accept(sentNewest),
      maxQueueSize: 2,
      batchSize: 2,
      flushIntervalMs: 60_000,
      scheduler: new FakeScheduler(),
      backpressure: "drop-newest",
    });
    newest.enqueue(featureEvent("evt-newest-1"));
    newest.enqueue(featureEvent("evt-newest-2"));
    expect(newest.enqueue(featureEvent("evt-newest-3"))).toMatchObject({
      status: "dropped",
      reason: "queue_overflow",
    });
    await newest.flush();
    expect(sentNewest).toEqual(["evt-newest-1", "evt-newest-2"]);
  });

  test("handles accepted, duplicate, permanent, retryable, and missing item results", async () => {
    const scheduler = new FakeScheduler();
    let call = 0;
    const transport: TelemetryTransport = {
      async send(events) {
        call++;
        if (call === 1)
          return {
            items: [
              { eventId: events[0]!.id, status: "accepted" },
              { eventId: events[1]!.id, status: "duplicate" },
              {
                eventId: events[2]!.id,
                status: "permanent_error",
                code: "invalid_metric",
              },
              {
                eventId: events[3]!.id,
                status: "retryable_error",
                retryAfterMs: 2_000,
              },
              // The fifth result is intentionally missing and must retry.
            ],
          };
        return {
          items: events.map((event) => ({
            eventId: event.id,
            status: "accepted" as const,
          })),
        };
      },
    };
    const adapter = createTelemetryAdapter({
      transport,
      batchSize: 5,
      flushIntervalMs: 60_000,
      retryBaseMs: 1_000,
      retryJitterRatio: 0,
      scheduler,
    });
    for (let index = 1; index <= 5; index++)
      adapter.enqueue(featureEvent(`evt-result-${index}`));
    expect(await adapter.flush()).toMatchObject({
      sent: 5,
      accepted: 1,
      duplicates: 1,
      permanent: 1,
      retryScheduled: 2,
      queueSize: 2,
    });
    expect(adapter.getSnapshot().nextFlushAt).toBe(2_000);
    scheduler.advance(2_000);
    expect(await adapter.flush()).toMatchObject({
      sent: 2,
      accepted: 2,
      queueSize: 0,
    });
  });

  test("retries transport failures with backoff and exhausts a bounded budget", async () => {
    const scheduler = new FakeScheduler();
    const diagnostics: TelemetryDiagnostic[] = [];
    const adapter = createTelemetryAdapter({
      transport: {
        async send() {
          throw new Error("offline");
        },
      },
      scheduler,
      maxAttempts: 2,
      retryBaseMs: 500,
      retryJitterRatio: 0,
      flushIntervalMs: 60_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    adapter.enqueue(featureEvent("evt-offline"));
    expect(await adapter.flush()).toMatchObject({
      retryScheduled: 1,
      queueSize: 1,
    });
    expect(adapter.getSnapshot().nextFlushAt).toBe(1_500);
    scheduler.advance(500);
    expect(await adapter.flush()).toMatchObject({ permanent: 1, queueSize: 0 });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "transport_error",
        "retry_scheduled",
        "retry_exhausted",
      ]),
    );
  });

  test("sanitizes non-finite retryAfterMs without wedging the queue", async () => {
    const scheduler = new FakeScheduler();
    const diagnostics: TelemetryDiagnostic[] = [];
    let calls = 0;
    const adapter = createTelemetryAdapter({
      transport: {
        async send(events) {
          calls++;
          return {
            items: events.map((event) =>
              calls === 1
                ? {
                    eventId: event.id,
                    status: "retryable_error" as const,
                    retryAfterMs: Number.NaN,
                  }
                : { eventId: event.id, status: "accepted" as const },
            ),
          };
        },
      },
      scheduler,
      retryBaseMs: 500,
      retryJitterRatio: 0,
      flushIntervalMs: 60_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    adapter.enqueue(featureEvent("evt-nan-retry"));
    expect(await adapter.flush()).toMatchObject({
      sent: 1,
      retryScheduled: 1,
      queueSize: 1,
    });
    expect(adapter.getSnapshot().nextFlushAt).toBe(1_500);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "invalid_response",
    );
    scheduler.advance(500);
    expect(await adapter.flush()).toMatchObject({
      sent: 1,
      accepted: 1,
      queueSize: 0,
    });
  });

  test("applies bounded symmetric retry jitter", async () => {
    class HighJitterScheduler extends FakeScheduler {
      override random(): number {
        return 1;
      }
    }
    const scheduler = new HighJitterScheduler();
    const adapter = createTelemetryAdapter({
      transport: {
        async send(events) {
          return {
            items: events.map((event) => ({
              eventId: event.id,
              status: "retryable_error" as const,
            })),
          };
        },
      },
      scheduler,
      retryBaseMs: 500,
      retryJitterRatio: 0.2,
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-jitter"));
    expect(await adapter.flush()).toMatchObject({ sent: 1, retryScheduled: 1 });
    expect(adapter.getSnapshot().nextFlushAt).toBe(1_600);
  });

  test("deduplicates exposure once per iteration and subject", () => {
    const events: FeatureEvent[] = [];
    const adapter = createTelemetryAdapter({
      onEvent: (event) => events.push(event),
    });
    const exposure = featureEvent("evt-exposure-1", {
      kind: "exposure",
      experiment: { experimentId: "checkout", iterationId: "iteration-1" },
    });
    expect(adapter.enqueue(exposure).status).toBe("callback_only");
    expect(
      adapter.enqueue({
        ...exposure,
        id: "evt-exposure-2",
        variation: "control",
      }).status,
    ).toBe("duplicate");
    expect(events).toHaveLength(1);
  });

  test("forgets an undelivered exposure evicted by backpressure", () => {
    const adapter = createTelemetryAdapter({
      transport: {
        async send(events) {
          return {
            items: events.map((event) => ({
              eventId: event.id,
              status: "accepted" as const,
            })),
          };
        },
      },
      maxQueueSize: 1,
      backpressure: "drop-oldest",
      scheduler: new FakeScheduler(),
      flushIntervalMs: 60_000,
    });
    const exposure = featureEvent("evt-evicted-exposure", {
      kind: "exposure",
      experiment: {
        experimentId: "checkout",
        iterationId: "iteration-evicted",
      },
    });
    expect(adapter.enqueue(exposure).status).toBe("queued");
    adapter.enqueue(featureEvent("evt-evicting-decision"));
    expect(adapter.getSnapshot().rememberedExposures).toBe(0);
    expect(
      adapter.enqueue({ ...exposure, id: "evt-reenqueued-exposure" }).status,
    ).toBe("queued");
    expect(adapter.getSnapshot().rememberedExposures).toBe(1);
  });

  test("rejects a conflicting active event id", () => {
    const adapter = createTelemetryAdapter({
      transport: {
        async send() {
          return { items: [] };
        },
      },
      scheduler: new FakeScheduler(),
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-conflict"));
    expect(
      adapter.enqueue(featureEvent("evt-conflict", { variation: "control" })),
    ).toMatchObject({ status: "dropped", reason: "event_id_conflict" });
  });

  test("guards diagnostics against recursive telemetry", () => {
    let nestedResult: ReturnType<TelemetryAdapter["enqueue"]> | undefined;
    let adapter: TelemetryAdapter;
    adapter = createTelemetryAdapter({
      onEvent() {
        throw new Error("callback failure");
      },
      onDiagnostic() {
        nestedResult = adapter.enqueue(featureEvent("evt-recursive"));
      },
    });
    expect(adapter.enqueue(featureEvent("evt-trigger"))).toMatchObject({
      status: "dropped",
      reason: "callback_error",
    });
    expect(nestedResult).toMatchObject({
      status: "dropped",
      reason: "diagnostic_recursion",
    });
  });

  test("rejects async event callbacks and observes their rejection", async () => {
    const diagnostics: TelemetryDiagnostic[] = [];
    const adapter = createTelemetryAdapter({
      async onEvent() {
        throw new Error("async callback failure");
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(adapter.enqueue(featureEvent("evt-async-callback"))).toMatchObject({
      status: "dropped",
      reason: "callback_error",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "callback_error",
        message: "Telemetry event callbacks must be synchronous",
      }),
    );
  });

  test("numeric tracking is feature scoped and attribute allow-listed", () => {
    const events: FeatureEvent[] = [];
    const adapter = createTelemetryAdapter({
      onEvent: (event) => events.push(event),
    });
    const input = {
      id: "evt-outcome",
      source: { app: "telemetry-tests", environment: "test" },
      flagKey: "checkout",
      variation: "treatment",
      configVersion: 11,
      reason: "SPLIT" as const,
      timestamp: "2030-01-01T00:00:02.000Z",
      sdk: { name: "core-tests", version: "1.0.0", platform: "node" as const },
      subject: {
        id: "psn_0123456789abcdef" as const,
        namespace: "telemetry-tests",
        revision: 1,
        state: "authenticated" as const,
      },
      exposureId: "evt-exposure-1",
      metric: { key: "checkout-value", revision: 3 },
      value: 42.5,
      attributes: { authorityClass: "server" },
      allowedAttributes: ["authorityClass"],
    };
    expect(adapter.trackNumeric(input).status).toBe("callback_only");
    expect(events[0]).toMatchObject({
      kind: "outcome",
      flagKey: "checkout",
      metric: { key: "checkout-value", revision: 3 },
      value: 42.5,
      dimensions: { authorityClass: "server" },
    });
    expect(() =>
      createNumericOutcomeEvent({
        ...input,
        allowedAttributes: [],
      }),
    ).toThrow("allow-list");
    expect(() =>
      createNumericOutcomeEvent({ ...input, value: Number.POSITIVE_INFINITY }),
    ).toThrow("finite");
  });

  test("coalesces concurrent flushes and shuts down without retaining events", async () => {
    let resolveTransport:
      | ((value: { items: { eventId: string; status: "accepted" }[] }) => void)
      | undefined;
    const adapter = createTelemetryAdapter({
      transport: {
        send(events) {
          return new Promise((resolve) => {
            resolveTransport = () =>
              resolve({
                items: events.map((event) => ({
                  eventId: event.id,
                  status: "accepted" as const,
                })),
              });
          });
        },
      },
      scheduler: new FakeScheduler(),
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-concurrent"));
    const first = adapter.flush();
    const second = adapter.flush();
    expect(first).toBe(second);
    await Promise.resolve();
    resolveTransport?.({ items: [] });
    expect(await first).toMatchObject({ accepted: 1 });
    adapter.enqueue(featureEvent("evt-shutdown"));
    expect(await adapter.shutdown({ flush: false })).toMatchObject({
      queueSize: 0,
    });
    expect(adapter.getSnapshot()).toMatchObject({ closed: true, queueSize: 0 });
    expect(adapter.enqueue(featureEvent("evt-after-close"))).toMatchObject({
      status: "dropped",
      reason: "closed",
    });
  });

  test("aborts an active signal-bound flush before default shutdown waits", async () => {
    const adapter = createTelemetryAdapter({
      transport: {
        send(_events, { signal }) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              {
                once: true,
              },
            );
          });
        },
      },
      scheduler: new FakeScheduler(),
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-signal-bound"));
    const activeFlush = adapter.flush();
    await Promise.resolve();
    const result = await adapter.shutdown();
    expect(result).toMatchObject({
      timedOut: false,
      dropped: 1,
      permanent: 0,
      queueSize: 0,
    });
    expect(adapter.getSnapshot()).toMatchObject({
      closing: true,
      closed: true,
      inFlight: false,
    });
    await activeFlush;
  });

  test("bounds shutdown when a transport ignores abort", async () => {
    const adapter = createTelemetryAdapter({
      transport: {
        async send() {
          return new Promise(() => undefined);
        },
      },
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-ignores-abort"));
    const startedAt = Date.now();
    const result = await adapter.shutdown({ timeoutMs: 10 });
    expect(result).toMatchObject({ timedOut: true, dropped: 1, queueSize: 0 });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("settles an existing flush when its transport ignores abort", async () => {
    const scheduler = new FakeScheduler();
    const adapter = createTelemetryAdapter({
      transport: {
        async send() {
          return new Promise(() => undefined);
        },
      },
      scheduler,
      flushIntervalMs: 60_000,
    });
    adapter.enqueue(featureEvent("evt-existing-ignores-abort"));
    const activeFlush = adapter.flush();
    await Promise.resolve();
    const shutdown = adapter.shutdown();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("flush ownership did not settle")),
        250,
      );
    });
    const [flushResult, shutdownResult] = await Promise.race([
      Promise.all([activeFlush, shutdown]),
      timeout,
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });
    expect(flushResult).toMatchObject({
      sent: 1,
      permanent: 0,
      queueSize: 0,
    });
    expect(shutdownResult).toMatchObject({
      sent: 1,
      timedOut: false,
      dropped: 1,
      permanent: 0,
      queueSize: 0,
    });
    expect(adapter.getSnapshot()).toMatchObject({
      closed: true,
      inFlight: false,
    });
  });

  test("default shutdown force-attempts delayed retries in its final drain", async () => {
    const scheduler = new FakeScheduler();
    let calls = 0;
    const adapter = createTelemetryAdapter({
      transport: {
        async send(events) {
          calls++;
          return {
            items: events.map((event) =>
              calls === 1
                ? {
                    eventId: event.id,
                    status: "retryable_error" as const,
                    retryAfterMs: 60_000,
                  }
                : { eventId: event.id, status: "accepted" as const },
            ),
          };
        },
      },
      scheduler,
      flushIntervalMs: 60_000,
      retryJitterRatio: 0,
    });
    adapter.enqueue(featureEvent("evt-delayed-shutdown-retry"));
    expect(await adapter.flush()).toMatchObject({
      retryScheduled: 1,
      queueSize: 1,
    });
    expect(adapter.getSnapshot().nextFlushAt).toBe(31_000);
    expect(await adapter.shutdown()).toMatchObject({
      sent: 1,
      accepted: 1,
      timedOut: false,
      dropped: 0,
      queueSize: 0,
    });
    expect(calls).toBe(2);
  });

  test("timer-driven delivery remains asynchronous from enqueue", async () => {
    const scheduler = new FakeScheduler();
    let sent = 0;
    const adapter = createTelemetryAdapter({
      transport: {
        async send(events) {
          sent += events.length;
          return {
            items: events.map((event) => ({
              eventId: event.id,
              status: "accepted" as const,
            })),
          };
        },
      },
      scheduler,
      batchSize: 2,
      flushIntervalMs: 10_000,
    });
    expect(adapter.enqueue(featureEvent("evt-timer-1")).status).toBe("queued");
    expect(sent).toBe(0);
    expect(adapter.enqueue(featureEvent("evt-timer-2")).status).toBe("queued");
    expect(sent).toBe(0);
    scheduler.runDue();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toBe(2);
  });
});
