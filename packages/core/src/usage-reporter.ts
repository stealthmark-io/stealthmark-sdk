// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Usage Reporter
// Batches metered agent events and POSTs them to /v1/usage/ingest.
// Never throws, never blocks the request path, dependency-free.
// ═══════════════════════════════════════════════════════════════════

import type {
  DetectionResult,
  UsageEvent,
  UsageLogger,
  UsageReporterOptions,
  UsageStats,
} from './types.js';

export const DEFAULT_USAGE_ENDPOINT = 'https://api.stealthmark.io';

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_BATCH = 100;
const MAX_BATCH_LIMIT = 500;
const MAX_QUEUE = 10_000;
const RETRY_DELAYS_MS = [250, 1000, 4000] as const;
const DEFAULT_RETRY_AFTER_SECONDS = 300;
const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 60;
const MAX_RATE_LIMIT_RETRY_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_IDENTIFIER_LENGTH = 256;

export interface UsageReporter {
  /** Whether events are being collected (false when no API key is configured) */
  readonly active: boolean;
  /** Queue an event. Never throws and never blocks. */
  record: (event: UsageEvent) => void;
  /** Send everything queued and wait for the in-flight request to finish. Never rejects. */
  flush: () => Promise<void>;
  stats: () => UsageStats;
}

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(callback: () => void, ms: number): TimerHandle {
  const handle = setTimeout(callback, ms);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') {
    handle.unref();
  }
  return handle;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unrefTimer(resolve, ms);
  });
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function requestSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/** Printable ASCII without spaces: the only characters an API key can carry in an HTTP header. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

type ApiKeyCheck = { kind: 'missing' } | { kind: 'valid'; key: string } | { kind: 'invalid'; length: number };

/**
 * Trims surrounding whitespace (a key pasted with a trailing newline) and rejects keys with control
 * or non-ASCII characters (a key typed with an arrow key in a terminal), which would make every
 * request fail before it leaves the process.
 */
export function checkApiKey(apiKey: string | undefined): ApiKeyCheck {
  const key = (apiKey ?? '').trim();
  if (key === '') return { kind: 'missing' };
  return API_KEY_PATTERN.test(key) ? { kind: 'valid', key } : { kind: 'invalid', length: key.length };
}

function normalizeEvent(event: UsageEvent): UsageEvent {
  const isBlocked = event.event_type === 'agent_blocked';
  const minUnits = isBlocked ? 0 : 1;
  const requested = event.units;
  const units = typeof requested === 'number' && Number.isInteger(requested) && requested >= minUnits ? requested : minUnits;
  return {
    ...event,
    units,
    occurred_at: event.occurred_at ?? new Date().toISOString(),
  };
}

/**
 * Resolves the identifier stored with a metered event: the explicit
 * x-stealthmark-agent header, else the User-Agent, else the detected agent id.
 */
export function resolveAgentIdentifier(
  headers: Headers | Record<string, string | undefined>,
  detection: DetectionResult
): string | undefined {
  const read = (name: string): string | undefined => {
    const value = headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()]);
    return value ? value.trim() : undefined;
  };
  // The canonical detected token ("GPTBot") groups every version of a crawler under one agent; the raw User-Agent is the last resort.
  const identifier = read('x-stealthmark-agent') || detection.agentId || read('user-agent');
  return identifier ? identifier.slice(0, MAX_IDENTIFIER_LENGTH) : undefined;
}

/**
 * Creates the best-effort usage reporter.
 *
 * Batches by `maxBatch` or `flushIntervalMs`, retries 5xx and network errors
 * three times (250 ms, 1 s, 4 s), and on 429 quota_exceeded pauses for
 * `retry_after_seconds`, dropping events meanwhile (counted in `stats().dropped`, with the resume time in
 * `stats().pausedUntil`). `onQuotaExceeded` lets the host app surface the pause. Any other 429 is a plain rate limit:
 * the batch is kept and sent again after the server's Retry-After, without reporting a quota pause.
 * Without an API key it is inert. A key that cannot be sent in a header, a key the API rejects and an
 * unreachable API each produce one warning through `options.logger` (default `console`).
 */
export function createUsageReporter(options: UsageReporterOptions): UsageReporter {
  const logger: UsageLogger | null = options.logger === false ? null : (options.logger ?? console);
  const warned = new Set<string>();
  function warnOnce(kind: string, message: string): void {
    if (logger === null || warned.has(kind)) return;
    warned.add(kind);
    try {
      logger.warn(`[stealthmark] ${message}`);
    } catch {
      // A failing logger must never break reporting.
    }
  }

  const keyCheck = checkApiKey(options.apiKey);
  if (keyCheck.kind === 'invalid') {
    warnOnce(
      'invalid-key',
      `The API key (${keyCheck.length} characters) contains spaces, control or non-ASCII characters, so it cannot be sent in an HTTP header. Usage reporting is off. Set STEALTHMARK_API_KEY again without extra characters.`
    );
  }
  const apiKey = keyCheck.kind === 'valid' ? keyCheck.key : '';
  const active = apiKey !== '';
  const url = `${(options.endpoint ?? DEFAULT_USAGE_ENDPOINT).replace(/\/+$/, '')}/v1/usage/ingest`;
  const flushIntervalMs = clampInt(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 1, 3_600_000);
  const maxBatch = clampInt(options.maxBatch, DEFAULT_MAX_BATCH, 1, MAX_BATCH_LIMIT);

  const queue: UsageEvent[] = [];
  let timer: TimerHandle | null = null;
  let inflight: Promise<void> | null = null;
  let sent = 0;
  let dropped = 0;
  let failures = 0;
  let pausedUntil = 0;
  let rateLimitedUntil = 0;

  const isPaused = (): boolean => pausedUntil > Date.now();
  const isRateLimited = (): boolean => rateLimitedUntil > Date.now();

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (timer !== null) return;
    const delay = Math.max(flushIntervalMs, rateLimitedUntil - Date.now());
    timer = unrefTimer(() => {
      timer = null;
      void flush();
    }, delay);
  }

  function dropQueued(): void {
    dropped += queue.length;
    queue.length = 0;
  }

  async function handleAccepted(response: Response, batchSize: number): Promise<void> {
    const body = await readJsonObject(response);
    const accepted = Math.min(numberField(body, 'accepted') ?? batchSize, batchSize);
    sent += accepted;
    dropped += batchSize - accepted;
  }

  function retryAfterHeaderSeconds(response: Response): number | undefined {
    const headerSeconds = Number(response.headers.get('retry-after'));
    return Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : undefined;
  }

  function handleQuotaExceeded(body: Record<string, unknown>, response: Response, batchSize: number): void {
    const retryAfter = numberField(body, 'retry_after_seconds')
      ?? retryAfterHeaderSeconds(response)
      ?? DEFAULT_RETRY_AFTER_SECONDS;
    pausedUntil = Date.now() + Math.max(retryAfter, 1) * 1000;
    const accepted = Math.min(numberField(body, 'accepted') ?? 0, batchSize);
    const droppedBefore = dropped;
    sent += accepted;
    dropped += batchSize - accepted;
    dropQueued();
    notifyQuotaExceeded(Math.max(retryAfter, 1), dropped - droppedBefore);
  }

  /**
   * A 429 that is not `quota_exceeded` is the API's per-key rate limiter. Nothing is wrong with the plan, so the
   * batch goes back to the front of the queue and sending resumes after Retry-After.
   */
  function handleRateLimited(body: Record<string, unknown>, response: Response, batch: UsageEvent[]): void {
    const retryAfter = retryAfterHeaderSeconds(response) ?? numberField(body, 'retry_after') ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS;
    rateLimitedUntil = Date.now() + Math.min(Math.max(retryAfter, 1), MAX_RATE_LIMIT_RETRY_SECONDS) * 1000;
    queue.unshift(...batch);
    if (queue.length > MAX_QUEUE) {
      dropped += queue.length - MAX_QUEUE;
      queue.length = MAX_QUEUE;
    }
  }

  function notifyQuotaExceeded(retryAfterSeconds: number, droppedNow: number): void {
    if (!options.onQuotaExceeded) return;
    try {
      options.onQuotaExceeded({ pausedUntil, retryAfterSeconds, dropped: droppedNow });
    } catch {
      // A failing host callback must never break reporting.
    }
  }

  async function sendBatch(batch: UsageEvent[]): Promise<void> {
    const payload = JSON.stringify({ events: batch });
    let lastFailure = 'no response';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: payload,
          signal: requestSignal(),
        });
      } catch (error) {
        // Only the error name: some runtimes put the rejected header value, the key, in the message.
        lastFailure = error instanceof Error ? error.name : typeof error;
        continue;
      }
      if (response.ok) {
        await handleAccepted(response, batch.length);
        return;
      }
      if (response.status === 429) {
        const body = await readJsonObject(response);
        if (body.error === 'quota_exceeded') {
          handleQuotaExceeded(body, response, batch.length);
        } else {
          handleRateLimited(body, response, batch);
        }
        return;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        if (response.status === 401 || response.status === 403) {
          warnOnce('rejected-key', `The usage API rejected the API key (HTTP ${response.status}); agent events are being dropped. Check STEALTHMARK_API_KEY.`);
        } else {
          warnOnce(`http-${response.status}`, `The usage API answered HTTP ${response.status}; agent events are being dropped.`);
        }
        failures += 1;
        dropped += batch.length;
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    }
    warnOnce('undelivered', `Could not deliver agent events to ${url} after ${RETRY_DELAYS_MS.length + 1} attempts (last: ${lastFailure}); they are being dropped.`);
    failures += 1;
    dropped += batch.length;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      if (isPaused()) {
        dropQueued();
        return;
      }
      if (isRateLimited()) return;
      const batch = queue.splice(0, maxBatch);
      try {
        await sendBatch(batch);
      } catch {
        failures += 1;
        dropped += batch.length;
      }
    }
  }

  function flush(): Promise<void> {
    clearTimer();
    if (inflight === null) {
      inflight = drain().finally(() => {
        inflight = null;
        if (queue.length > 0) schedule();
      });
    }
    return inflight;
  }

  return {
    active,

    record(event: UsageEvent): void {
      if (!active) return;
      try {
        if (isPaused() || queue.length >= MAX_QUEUE) {
          dropped += 1;
          return;
        }
        queue.push(normalizeEvent(event));
        if (queue.length >= maxBatch) {
          void flush();
        } else {
          schedule();
        }
      } catch {
        dropped += 1;
      }
    },

    flush,

    stats(): UsageStats {
      return {
        queued: queue.length,
        sent,
        dropped,
        failures,
        pausedUntil: isPaused() ? pausedUntil : null,
        quotaExceededUntil: isPaused() ? pausedUntil : null,
      };
    },
  };
}
