import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStealthMark } from '../create.js';

const SITE_A = '3f1c2b4e-8a6d-4c1e-9b7a-0d5e6f7a8b9c';
const SITE_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

interface SentBody {
  events: Array<Record<string, unknown>>;
}

describe('createStealthMark siteId', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('STEALTHMARK_SITE_ID', '');
    fetchMock = vi.fn(async () => new Response('{"accepted":1,"rejected":0}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function sentEvents(): Promise<Array<Record<string, unknown>>> {
    await vi.advanceTimersByTimeAsync(1000);
    return fetchMock.mock.calls.flatMap(
      (call) => (JSON.parse((call[1] as { body: string }).body) as SentBody).events
    );
  }

  const base = { siteName: 'Site', apiKey: 'sk_live_test', usageEndpoint: 'https://api.test' };

  it('attaches the configured siteId to every metered event', async () => {
    const sm = createStealthMark({ ...base, siteId: SITE_A });
    sm.recordAgentEvent({ event_type: 'agent_request', metadata: { path: '/' } });
    sm.recordAgentEvent({ event_type: 'agent_blocked', metadata: { path: '/x' } });

    expect(sm.siteId).toBe(SITE_A);
    const events = await sentEvents();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.site_id)).toEqual([SITE_A, SITE_A]);
  });

  it('falls back to STEALTHMARK_SITE_ID', async () => {
    vi.stubEnv('STEALTHMARK_SITE_ID', SITE_B);
    const sm = createStealthMark(base);
    sm.recordAgentEvent({ event_type: 'agent_request' });

    expect(sm.siteId).toBe(SITE_B);
    expect((await sentEvents())[0].site_id).toBe(SITE_B);
  });

  it('prefers the config value over the environment', () => {
    vi.stubEnv('STEALTHMARK_SITE_ID', SITE_B);
    expect(createStealthMark({ ...base, siteId: SITE_A }).siteId).toBe(SITE_A);
  });

  it('trims and lowercases the id so it matches the stored site id', () => {
    expect(createStealthMark({ ...base, siteId: `  ${SITE_A.toUpperCase()} ` }).siteId).toBe(SITE_A);
  });

  it('keeps a site_id set explicitly on the event', async () => {
    const sm = createStealthMark({ ...base, siteId: SITE_A });
    sm.recordAgentEvent({ event_type: 'agent_request', site_id: SITE_B });

    expect((await sentEvents())[0].site_id).toBe(SITE_B);
  });

  it('sends no site_id when none is configured', async () => {
    const sm = createStealthMark(base);
    sm.recordAgentEvent({ event_type: 'agent_request' });

    expect(sm.siteId).toBeUndefined();
    expect(await sentEvents()).toEqual([expect.not.objectContaining({ site_id: expect.anything() })]);
  });

  it('ignores an id that is not a UUID and warns once, so the batch is not rejected by the API', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sm = createStealthMark({ ...base, siteId: 'my-site' });
    sm.recordAgentEvent({ event_type: 'agent_request' });
    sm.recordAgentEvent({ event_type: 'agent_request' });

    expect(sm.siteId).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const events = await sentEvents();
    expect(events).toHaveLength(2);
    expect(events.every((event) => !('site_id' in event))).toBe(true);
  });
});
