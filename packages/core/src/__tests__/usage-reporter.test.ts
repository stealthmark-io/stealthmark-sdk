import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUsageReporter } from '../usage-reporter.js';
import { createStealthMark } from '../create.js';

interface SentBody {
  events: Array<Record<string, unknown>>;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): SentBody[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body) as SentBody);
}

describe('createUsageReporter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => jsonResponse(200, { accepted: 1, rejected: 0 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('posts to /v1/usage/ingest with bearer auth and stamps units and occurred_at', async () => {
    const reporter = createUsageReporter({ apiKey: 'sk_live_test', endpoint: 'https://api.example.com/' });
    reporter.record({ event_type: 'agent_request', agent_identifier: 'GPTBot', metadata: { path: '/' } });
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; method: string }];
    expect(url).toBe('https://api.example.com/v1/usage/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer sk_live_test');
    const [body] = sentBodies(fetchMock);
    expect(body.events[0]).toMatchObject({ event_type: 'agent_request', units: 1, agent_identifier: 'GPTBot' });
    expect(typeof body.events[0].occurred_at).toBe('string');
    expect(reporter.stats()).toMatchObject({ queued: 0, sent: 1, dropped: 0, failures: 0 });
  });

  it('normalizes invalid units to 1', async () => {
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({ units: 0 });
    reporter.record({ units: 2.5 });
    reporter.record({ units: 3 });
    await reporter.flush();
    const units = sentBodies(fetchMock)[0].events.map((event) => event.units);
    expect(units).toEqual([1, 1, 3]);
  });

  it('sends units 0 for agent_blocked events and keeps units >= 1 for every other type', async () => {
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({ event_type: 'agent_blocked' });
    reporter.record({ event_type: 'agent_blocked', units: 0 });
    reporter.record({ event_type: 'agent_blocked', units: -2 });
    reporter.record({ event_type: 'agent_manifest', units: 0 });
    reporter.record({ event_type: 'agent_request' });
    await reporter.flush();
    const sent = sentBodies(fetchMock)[0].events.map((event) => [event.event_type, event.units]);
    expect(sent).toEqual([
      ['agent_blocked', 0],
      ['agent_blocked', 0],
      ['agent_blocked', 0],
      ['agent_manifest', 1],
      ['agent_request', 1],
    ]);
  });

  it('flushes immediately when maxBatch is reached and splits by batch size', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const count = (JSON.parse(init.body) as SentBody).events.length;
      return jsonResponse(200, { accepted: count, rejected: 0 });
    });
    const reporter = createUsageReporter({ apiKey: 'k', maxBatch: 3, flushIntervalMs: 60_000 });
    for (let i = 0; i < 7; i += 1) reporter.record({ metadata: { i } });
    await reporter.flush();

    expect(sentBodies(fetchMock).map((body) => body.events.length)).toEqual([3, 3, 1]);
    expect(reporter.stats().sent).toBe(7);
  });

  it('flushes by interval when the batch is not full', async () => {
    const reporter = createUsageReporter({ apiKey: 'k', flushIntervalMs: 1000, maxBatch: 100 });
    reporter.record({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reporter.stats().queued).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reporter.stats()).toMatchObject({ queued: 0, sent: 1 });
  });

  it('retries with backoff on 500 and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(200, { accepted: 1, rejected: 0 }));
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({});
    const done = reporter.flush();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await done;

    expect(reporter.stats()).toMatchObject({ sent: 1, dropped: 0, failures: 0 });
  });

  it('gives up after three retries, counting one failed batch and dropped events', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(500, { error: 'boom' }));
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({});
    reporter.record({});
    const done = reporter.flush();
    await vi.advanceTimersByTimeAsync(250 + 1000 + 4000);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(reporter.stats()).toMatchObject({ sent: 0, dropped: 2, failures: 1, queued: 0 });
  });

  it('does not retry non-retryable 4xx responses', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: 'unauthorized' }));
    const reporter = createUsageReporter({ apiKey: 'bad' });
    reporter.record({});
    await reporter.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reporter.stats()).toMatchObject({ dropped: 1, failures: 1 });
  });

  it('counts rejected events from a partial 200 as dropped', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { accepted: 2, rejected: 1 }));
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({});
    reporter.record({});
    reporter.record({});
    await reporter.flush();

    expect(reporter.stats()).toMatchObject({ sent: 2, dropped: 1 });
  });

  it('pauses on 429, drops queued and new events, then resumes after retry_after_seconds', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(429, { error: 'quota_exceeded', accepted: 1, rejected: 1, retry_after_seconds: 60 })
    );
    const reporter = createUsageReporter({ apiKey: 'k', maxBatch: 2, flushIntervalMs: 60_000 });
    const start = Date.now();
    reporter.record({});
    reporter.record({});
    await vi.advanceTimersByTimeAsync(0);

    let stats = reporter.stats();
    expect(stats.sent).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(stats.quotaExceededUntil).toBe(start + 60_000);

    reporter.record({});
    reporter.record({});
    await reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stats = reporter.stats();
    expect(stats.dropped).toBe(3);
    expect(stats.queued).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reporter.stats().quotaExceededUntil).toBeNull();
    fetchMock.mockImplementation(async () => jsonResponse(200, { accepted: 1, rejected: 0 }));
    reporter.record({});
    await reporter.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reporter.stats().sent).toBe(2);
  });

  it('defaults the pause to 300 seconds when the 429 has no retry hint', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { error: 'quota_exceeded' }));
    const reporter = createUsageReporter({ apiKey: 'k' });
    const start = Date.now();
    reporter.record({});
    await reporter.flush();

    expect(reporter.stats().quotaExceededUntil).toBe(start + 300_000);
  });

  it('exposes pausedUntil in stats and calls onQuotaExceeded with the pause details', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(429, { error: 'quota_exceeded', accepted: 1, rejected: 1, retry_after_seconds: 60 })
    );
    const onQuotaExceeded = vi.fn();
    const reporter = createUsageReporter({ apiKey: 'k', maxBatch: 2, flushIntervalMs: 60_000, onQuotaExceeded });
    const start = Date.now();
    expect(reporter.stats().pausedUntil).toBeNull();
    reporter.record({});
    reporter.record({});
    await vi.advanceTimersByTimeAsync(0);

    expect(reporter.stats().pausedUntil).toBe(start + 60_000);
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
    expect(onQuotaExceeded).toHaveBeenCalledWith({ pausedUntil: start + 60_000, retryAfterSeconds: 60, dropped: 1 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reporter.stats().pausedUntil).toBeNull();
  });

  it('keeps reporting when the onQuotaExceeded callback throws', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { error: 'quota_exceeded' }));
    const reporter = createUsageReporter({
      apiKey: 'k',
      onQuotaExceeded: () => {
        throw new Error('host callback failed');
      },
    });
    reporter.record({});
    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(reporter.stats().pausedUntil).not.toBeNull();
  });

  describe('429 rate_limit_exceeded (per-key rate limiter, not the plan quota)', () => {
    function rateLimited(headers: Record<string, string> = {}, body: Record<string, unknown> = { error: 'rate_limit_exceeded', retry_after: 30 }): Response {
      return new Response(JSON.stringify(body), {
        status: 429,
        headers: { 'content-type': 'application/json', ...headers },
      });
    }

    function acceptAll(): void {
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        const count = (JSON.parse(init.body) as SentBody).events.length;
        return jsonResponse(200, { accepted: count, rejected: 0 });
      });
    }

    it('keeps the batch, does not pause, does not call onQuotaExceeded and resends after Retry-After', async () => {
      fetchMock.mockImplementationOnce(async () => rateLimited({ 'retry-after': '30' }));
      acceptAll();
      const onQuotaExceeded = vi.fn();
      const reporter = createUsageReporter({ apiKey: 'k', onQuotaExceeded });
      reporter.record({ event_type: 'agent_request', agent_identifier: 'GPTBot' });
      await reporter.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reporter.stats()).toMatchObject({ queued: 1, sent: 0, dropped: 0, failures: 0, pausedUntil: null, quotaExceededUntil: null });
      expect(onQuotaExceeded).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentBodies(fetchMock)[1].events[0]).toMatchObject({ agent_identifier: 'GPTBot' });
      expect(reporter.stats()).toMatchObject({ queued: 0, sent: 1, dropped: 0, failures: 0 });
      expect(onQuotaExceeded).not.toHaveBeenCalled();
    });

    it('queues new events during the backoff instead of dropping them and sends them with the kept batch', async () => {
      fetchMock.mockImplementationOnce(async () => rateLimited({ 'retry-after': '10' }));
      acceptAll();
      const reporter = createUsageReporter({ apiKey: 'k' });
      reporter.record({ metadata: { n: 1 } });
      await reporter.flush();

      reporter.record({ metadata: { n: 2 } });
      reporter.record({ metadata: { n: 3 } });
      await reporter.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reporter.stats()).toMatchObject({ queued: 3, dropped: 0, pausedUntil: null });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentBodies(fetchMock)[1].events.map((event) => (event.metadata as { n: number }).n)).toEqual([1, 2, 3]);
      expect(reporter.stats()).toMatchObject({ queued: 0, sent: 3, dropped: 0 });
    });

    it('falls back to the retry_after field of the body when there is no Retry-After header', async () => {
      fetchMock.mockImplementationOnce(async () => rateLimited({}, { error: 'rate_limit_exceeded', retry_after: 5 }));
      acceptAll();
      const reporter = createUsageReporter({ apiKey: 'k' });
      reporter.record({});
      await reporter.flush();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('treats a 429 without a quota_exceeded error as a rate limit and waits 60 seconds when there is no hint', async () => {
      fetchMock.mockImplementationOnce(async () => new Response('Too Many Requests', { status: 429 }));
      acceptAll();
      const onQuotaExceeded = vi.fn();
      const reporter = createUsageReporter({ apiKey: 'k', onQuotaExceeded });
      reporter.record({});
      await reporter.flush();

      expect(reporter.stats()).toMatchObject({ queued: 1, dropped: 0, pausedUntil: null });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onQuotaExceeded).not.toHaveBeenCalled();
    });

    it('caps an oversized Retry-After at 300 seconds', async () => {
      fetchMock.mockImplementationOnce(async () => rateLimited({ 'retry-after': '86400' }));
      acceptAll();
      const reporter = createUsageReporter({ apiKey: 'k' });
      reporter.record({});
      await reporter.flush();

      await vi.advanceTimersByTimeAsync(299_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('still pauses and reports quota_exceeded when the plan quota is the cause', async () => {
      fetchMock.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ error: 'quota_exceeded', retry_after_seconds: 60 }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        })
      );
      const onQuotaExceeded = vi.fn();
      const reporter = createUsageReporter({ apiKey: 'k', onQuotaExceeded });
      reporter.record({});
      await reporter.flush();

      expect(reporter.stats()).toMatchObject({ queued: 0, dropped: 1 });
      expect(reporter.stats().pausedUntil).not.toBeNull();
      expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
    });
  });

  it('forwards onQuotaExceeded from createStealthMark config', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(429, { error: 'quota_exceeded', retry_after_seconds: 5 }));
    const onQuotaExceeded = vi.fn();
    const sm = createStealthMark({ siteName: 'Quota Site', apiKey: 'k', onQuotaExceeded });
    sm.recordAgentEvent({ event_type: 'agent_request' });
    await sm.usage.flush();
    expect(onQuotaExceeded).toHaveBeenCalledTimes(1);
  });

  it('never throws or rejects when fetch rejects', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    const reporter = createUsageReporter({ apiKey: 'k' });

    expect(() => reporter.record({ event_type: 'agent_request' })).not.toThrow();
    const done = reporter.flush();
    await vi.advanceTimersByTimeAsync(5250);
    await expect(done).resolves.toBeUndefined();
    expect(reporter.stats()).toMatchObject({ failures: 1, dropped: 1, sent: 0 });
  });

  it('never throws when fetch is unavailable', async () => {
    vi.stubGlobal('fetch', undefined);
    const reporter = createUsageReporter({ apiKey: 'k' });
    reporter.record({});
    const done = reporter.flush();
    await vi.advanceTimersByTimeAsync(5250);
    await expect(done).resolves.toBeUndefined();
    expect(reporter.stats().failures).toBe(1);
  });

  it('is inert without an API key', async () => {
    const reporter = createUsageReporter({ apiKey: '' });
    reporter.record({});
    await reporter.flush();

    expect(reporter.active).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reporter.stats()).toMatchObject({ queued: 0, sent: 0, dropped: 0 });
  });
});

describe('createStealthMark usage wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { accepted: 1, rejected: 0 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is inactive without an API key', () => {
    vi.stubEnv('STEALTHMARK_API_KEY', '');
    const sm = createStealthMark({ siteName: 'Site' });
    expect(sm.usage.active).toBe(false);
    sm.recordAgentEvent({ event_type: 'agent_request' });
    expect(sm.usage.stats().queued).toBe(0);
  });

  it('is active when apiKey is set and reports through recordAgentEvent', async () => {
    const sm = createStealthMark({ siteName: 'Site', apiKey: 'sk_live_x', usageEndpoint: 'https://api.test' });
    sm.recordAgentEvent({ event_type: 'agent_manifest', agent_identifier: 'ClaudeBot' });
    expect(sm.usage.stats().queued).toBe(1);
    await sm.usage.flush();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/usage/ingest');
    expect(sm.usage.stats().sent).toBe(1);
  });

  it('reads STEALTHMARK_API_KEY and STEALTHMARK_USAGE_ENDPOINT from the environment', async () => {
    vi.stubEnv('STEALTHMARK_API_KEY', 'sk_live_env');
    vi.stubEnv('STEALTHMARK_USAGE_ENDPOINT', 'https://env.test');
    const sm = createStealthMark({ siteName: 'Site' });
    expect(sm.usage.active).toBe(true);
    sm.recordAgentEvent({});
    await sm.usage.flush();
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://env.test/v1/usage/ingest');
    expect(init.headers.authorization).toBe('Bearer sk_live_env');
  });

  it('reportUsage: false disables usage reporting even with a key', () => {
    const sm = createStealthMark({ siteName: 'Site', apiKey: 'sk_live_x', reportUsage: false });
    expect(sm.usage.active).toBe(false);
  });
});

describe('usage reporter warnings', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnings: string[];
  const logger = { warn: (message: string) => warnings.push(message) };

  beforeEach(() => {
    vi.useFakeTimers();
    warnings = [];
    fetchMock = vi.fn(async () => jsonResponse(200, { accepted: 1, rejected: 0 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('trims whitespace around the key before sending it', async () => {
    const reporter = createUsageReporter({ apiKey: '  sk_live_test\n', logger });
    reporter.record({ agent_identifier: 'GPTBot' });
    await reporter.flush();

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe('Bearer sk_live_test');
    expect(warnings).toEqual([]);
  });

  it('turns reporting off and warns once, without the key, when the key has control characters', async () => {
    const reporter = createUsageReporter({ apiKey: 'sk_live_test\u001b[C', logger });
    reporter.record({ agent_identifier: 'GPTBot' });
    await reporter.flush();

    expect(reporter.active).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cannot be sent in an HTTP header');
    expect(warnings[0]).not.toContain('sk_live_test');
  });

  it('warns once when the API rejects the key, however many batches fail', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: 'invalid_api_key' }));
    const reporter = createUsageReporter({ apiKey: 'sk_live_revoked', logger });
    for (let i = 0; i < 3; i += 1) {
      reporter.record({ agent_identifier: 'GPTBot' });
      await reporter.flush();
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('HTTP 401');
    expect(warnings[0]).not.toContain('sk_live_revoked');
    expect(reporter.stats().dropped).toBe(3);
  });

  it('warns once with only the error name when the API cannot be reached', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Headers.append: "Bearer sk_live_secret" is an invalid header value.');
    });
    const reporter = createUsageReporter({ apiKey: 'sk_live_secret', logger });
    reporter.record({ agent_identifier: 'GPTBot' });
    const flushed = reporter.flush();
    await vi.runAllTimersAsync();
    await flushed;

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('(last: TypeError)');
    expect(warnings[0]).not.toContain('sk_live_secret');
  });

  it('names the last HTTP status when the API keeps answering 5xx', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { error: 'service_unavailable' }));
    const reporter = createUsageReporter({ apiKey: 'sk_live_test', logger });
    reporter.record({ agent_identifier: 'GPTBot' });
    const flushed = reporter.flush();
    await vi.runAllTimersAsync();
    await flushed;

    expect(warnings).toEqual([expect.stringContaining('(last: HTTP 503)')]);
  });

  it('warns once for other 4xx answers with the status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, { error: 'invalid_event' }));
    const reporter = createUsageReporter({ apiKey: 'sk_live_test', logger });
    reporter.record({ agent_identifier: 'GPTBot' });
    await reporter.flush();
    reporter.record({ agent_identifier: 'GPTBot' });
    await reporter.flush();

    expect(warnings).toEqual([expect.stringContaining('HTTP 422')]);
  });

  it('stays silent when the logger is false', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = createUsageReporter({ apiKey: 'bad key', logger: false });

    expect(reporter.active).toBe(false);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('keeps reporting when the logger itself throws', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { error: 'invalid_api_key' }));
    const throwing = { warn: () => { throw new Error('logger down'); } };
    const reporter = createUsageReporter({ apiKey: 'sk_live_test', logger: throwing });
    reporter.record({ agent_identifier: 'GPTBot' });

    await expect(reporter.flush()).resolves.toBeUndefined();
    expect(reporter.stats().dropped).toBe(1);
  });

  it('accepts the logger through createStealthMark, which every adapter uses', async () => {
    const sm = createStealthMark({ siteName: 'Test', apiKey: 'sk_live_test\u001b[C', logger });

    expect(sm.usage.active).toBe(false);
    expect(warnings).toEqual([expect.stringContaining('cannot be sent in an HTTP header')]);
  });
});
