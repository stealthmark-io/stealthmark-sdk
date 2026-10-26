import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { stealthmark, withStealthMark } from '../middleware.js';

// ═══════════════════════════════════════════════════════════════════
// stealthmark() — Main Middleware Factory
// ═══════════════════════════════════════════════════════════════════

function expectResponse(response: Response | undefined): Response {
  if (response === undefined) throw new Error('expected the middleware to return a response');
  return response;
}

describe('stealthmark middleware', () => {
  const config = {
    siteName: 'Test App',
    capabilities: [
      { id: 'search', endpoint: '/api/search', method: 'GET' as const },
    ],
  };

  function makeRequest(overrides: {
    pathname?: string;
    accept?: string;
    userAgent?: string;
    agentHeader?: string;
  } = {}): { headers: Headers; nextUrl: { pathname: string }; method: string } {
    const headers = new Headers();
    headers.set('accept', overrides.accept ?? 'text/html');
    headers.set('user-agent', overrides.userAgent ?? 'Mozilla/5.0 Chrome/126.0');
    if (overrides.agentHeader) {
      headers.set('x-stealthmark-agent', overrides.agentHeader);
    }
    return {
      headers,
      nextUrl: { pathname: overrides.pathname ?? '/' },
      method: 'GET',
    };
  }

  it('returns agent manifest on /.well-known/agent.json', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json' })));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/agent+json; charset=utf-8');

    const body = (await response.json()) as { name: string; capabilities: Array<{ id: string }> };
    expect(body.name).toBe('Test App');
    expect(body.capabilities).toHaveLength(1);
    expect(body.capabilities[0].id).toBe('search');
  });

  it('returns agent manifest on /.well-known/ai-plugin.json', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ pathname: '/.well-known/ai-plugin.json' })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe('Test App');
  });

  it('returns agent manifest on /api/agent-manifest', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ pathname: '/api/agent-manifest' })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { protocol: string };
    expect(body.protocol).toBe('stealthmark_agent_governance_v1');
  });

  it('serves manifest to agent with application/agent+json Accept', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ accept: 'application/agent+json' })));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/agent+json; charset=utf-8');
    expect(response.headers.get('x-stealthmark-route')).toBe('DUAL_DOOR_AGENT_FASTPATH');
  });

  it('observes agents by default: returns undefined so Next.js continues the chain', async () => {
    const mw = stealthmark(config);

    expect(await mw(makeRequest({ agentHeader: 'claude-code-v1' }))).toBeUndefined();
  });

  it('agentPolicy "manifest" serves the manifest to every agent request', async () => {
    const mw = stealthmark({ ...config, agentPolicy: 'manifest' });
    const response = expectResponse(await mw(makeRequest({ agentHeader: 'claude-code-v1' })));

    const body = (await response.json()) as { name: string };
    expect(body.name).toBe('Test App');
  });

  it('agentPolicy "block" answers 403 to agents but still serves the manifest on request', async () => {
    const mw = stealthmark({ ...config, agentPolicy: 'block' });

    expect((await mw(makeRequest({ agentHeader: 'claude-code-v1' })))?.status).toBe(403);
    expect((await mw(makeRequest({ accept: 'application/agent+json' })))?.status).toBe(200);
  });

  it('returns undefined for normal browser requests instead of blanking the page', async () => {
    const mw = stealthmark(config);

    expect(await mw(makeRequest())).toBeUndefined();
  });

  it('still puts shield headers on manifest responses', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json' })));

    expect(response?.headers.get('x-stealthmark-shield')).toBe('ACTIVE');
    expect(response?.headers.get('x-stealthmark-agent-policy')).toBe('observe');
  });

  it('tags manifest responses with detection headers only for agents', async () => {
    const mw = stealthmark(config);
    const agentResponse = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json', agentHeader: 'example-agent-v1' })));
    expect(agentResponse.headers.get('x-stealthmark-agent-detected')).toBe('true');
    expect(agentResponse.headers.get('x-stealthmark-agent-id')).toBe('example-agent-v1');

    const humanResponse = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json' })));
    expect(humanResponse.headers.get('x-stealthmark-agent-detected')).toBeNull();
  });

  it('includes CORS headers on agent responses', async () => {
    const mw = stealthmark(config);
    const response = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json' })));

    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('advertises the configured agent policy in the manifest', async () => {
    const mw = stealthmark({ ...config, agentPolicy: 'block' });
    const response = expectResponse(await mw(makeRequest({ pathname: '/.well-known/agent.json' })));
    const body = (await response.json()) as { agent_policy: { mode: string } };

    expect(body.agent_policy.mode).toBe('block');
  });
});

// ═══════════════════════════════════════════════════════════════════
// withStealthMark() — Composition Wrapper
// ═══════════════════════════════════════════════════════════════════

describe('withStealthMark composition wrapper', () => {
  const config = {
    siteName: 'Composed App',
    capabilities: [],
  };

  it('intercepts agent requests before existing middleware', async () => {
    const existing = () => new Response('original', { status: 200 });
    const mw = withStealthMark(existing, config);

    const headers = new Headers();
    headers.set('accept', 'application/agent+json');
    headers.set('user-agent', 'test');

    const response = await mw({ headers, nextUrl: { pathname: '/' }, method: 'GET' });
    const body = (await response?.json()) as { name: string };

    expect(body.name).toBe('Composed App');
    expect(response?.headers.get('content-type')).toBe('application/agent+json; charset=utf-8');
  });

  it('falls through to existing middleware for human requests', async () => {
    const existing = () => new Response('Hello Human', {
      status: 200,
      headers: { 'x-custom': 'preserved' },
    });
    const mw = withStealthMark(existing, config);

    const headers = new Headers();
    headers.set('accept', 'text/html');
    headers.set('user-agent', 'Mozilla/5.0 Chrome/126.0');

    const response = await mw({ headers, nextUrl: { pathname: '/' }, method: 'GET' });
    const body = await response?.text();

    expect(body).toBe('Hello Human');
    expect(response?.headers.get('x-custom')).toBe('preserved');
    expect(response?.headers.get('x-stealthmark-shield')).toBe('ACTIVE');
  });

  it('stamps shield and detection headers on the existing response when an agent is observed', async () => {
    const existing = () => new Response('page', { status: 200, headers: { 'x-custom': 'preserved' } });
    const mw = withStealthMark(existing, config);

    const headers = new Headers();
    headers.set('accept', 'text/html');
    headers.set('user-agent', 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)');

    const response = await mw({ headers, nextUrl: { pathname: '/' }, method: 'GET' });

    expect(await response?.text()).toBe('page');
    expect(response?.headers.get('x-custom')).toBe('preserved');
    expect(response?.headers.get('x-stealthmark-shield')).toBe('ACTIVE');
    expect(response?.headers.get('x-stealthmark-agent-detected')).toBe('true');
    expect(response?.headers.get('x-stealthmark-agent-id')).toBe('OAI-SearchBot');
  });

  it('continues the chain untouched when the existing middleware returns nothing', async () => {
    const mw = withStealthMark(() => undefined, config);

    const headers = new Headers();
    headers.set('accept', 'text/html');
    headers.set('user-agent', 'Mozilla/5.0 Chrome/126.0');

    expect(await mw({ headers, nextUrl: { pathname: '/' }, method: 'GET' })).toBeUndefined();
  });

  it('intercepts well-known paths before existing middleware', async () => {
    const existing = () => new Response('should not reach', { status: 404 });
    const mw = withStealthMark(existing, config);

    const headers = new Headers();
    headers.set('accept', 'text/html');
    headers.set('user-agent', 'Chrome');

    const response = await mw({ headers, nextUrl: { pathname: '/.well-known/agent.json' }, method: 'GET' });

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { name: string };
    expect(body.name).toBe('Composed App');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Usage metering
// ═══════════════════════════════════════════════════════════════════

describe('stealthmark usage metering', () => {
  const config = {
    siteName: 'Metered App',
    apiKey: 'sk_live_test',
    usageEndpoint: 'https://api.test',
  };

  function request(path: string, headers: Record<string, string>, method = 'GET') {
    return { headers: new Headers(headers), nextUrl: { pathname: path }, method };
  }

  async function ingestedEvents(): Promise<Array<Record<string, unknown>>> {
    await vi.advanceTimersByTimeAsync(1000);
    return vi
      .mocked(fetch)
      .mock.calls.filter((call) => String(call[0]).endsWith('/v1/usage/ingest'))
      .flatMap((call) => (JSON.parse(String((call[1] as { body: string }).body)) as { events: Array<Record<string, unknown>> }).events);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"accepted":1,"rejected":0}', { status: 200 })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('records exactly one agent_request for an agent request', async () => {
    const mw = stealthmark(config);
    await mw(request('/pricing', { 'user-agent': 'Mozilla/5.0 GPTBot/1.0', accept: 'text/html' }, 'POST'));

    const events = await ingestedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'agent_request',
      metadata: { path: '/pricing', method: 'POST' },
    });
    expect(String(events[0].agent_identifier)).toContain('GPTBot');
  });

  it('prefers the x-stealthmark-agent header as agent_identifier', async () => {
    const mw = stealthmark(config);
    await mw(request('/', { 'x-stealthmark-agent': 'example-agent-v1', 'user-agent': 'node-fetch' }));

    const events = await ingestedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].agent_identifier).toBe('example-agent-v1');
  });

  it('records agent_manifest once when an agent fetches the manifest', async () => {
    const mw = stealthmark(config);
    await mw(request('/.well-known/agent.json', { 'x-stealthmark-agent': 'example-agent-v1' }));

    const events = await ingestedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('agent_manifest');
  });

  it('records nothing for a human request', async () => {
    const mw = stealthmark(config);
    await mw(request('/', { 'user-agent': 'Mozilla/5.0 Chrome/126.0', accept: 'text/html' }));
    await mw(request('/.well-known/agent.json', { 'user-agent': 'Mozilla/5.0 Chrome/126.0', accept: 'text/html' }));

    expect(await ingestedEvents()).toHaveLength(0);
  });

  it('withStealthMark records one event for agents and none for humans', async () => {
    const downstream = vi.fn(() => new Response('ok'));
    const mw = withStealthMark(downstream, config);

    await mw(request('/docs', { 'user-agent': 'ClaudeBot/1.0' }));
    await mw(request('/docs', { 'user-agent': 'Mozilla/5.0 Chrome/126.0', accept: 'text/html' }));

    const events = await ingestedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'agent_request', metadata: { path: '/docs', method: 'GET' } });
    // Observe policy: the agent request also reaches the site's own middleware
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it('only calls the usage ingest endpoint for an agent request with an API key', async () => {
    const mw = stealthmark(config);
    await mw(request('/pricing', { 'user-agent': 'Mozilla/5.0 GPTBot/1.0', accept: 'text/html' }));
    await vi.advanceTimersByTimeAsync(1000);

    const urls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(['https://api.test/v1/usage/ingest']);
  });

  it('does not meter without an API key', async () => {
    const mw = stealthmark({ siteName: 'No Key' });
    await mw(request('/', { 'x-stealthmark-agent': 'example-agent-v1' }));

    expect(await ingestedEvents()).toHaveLength(0);
  });

  describe('site attribution', () => {
    const SITE_ID = '3f1c2b4e-8a6d-4c1e-9b7a-0d5e6f7a8b9c';
    const ENV_SITE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const attributed = { ...config, siteId: SITE_ID };
    const agent = { 'user-agent': 'Mozilla/5.0 GPTBot/1.0', accept: 'text/html' };

    beforeEach(() => {
      vi.stubEnv('STEALTHMARK_SITE_ID', '');
    });

    it('tags the event with site_id and, with trustForwardedHost, the first x-forwarded-host, lowercased and without port', async () => {
      const mw = stealthmark({ ...attributed, trustForwardedHost: true });
      await mw(request('/pricing', { ...agent, host: 'internal:3000', 'x-forwarded-host': 'Shop.Example.com:443, edge.proxy' }));

      const events = await ingestedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'agent_request',
        site_id: SITE_ID,
        metadata: { path: '/pricing', method: 'GET', host: 'shop.example.com' },
      });
    });

    it('ignores a spoofed x-forwarded-host by default and records the host header', async () => {
      const mw = stealthmark(attributed);
      await mw(request('/pricing', { ...agent, host: 'Real.Example.com:3000', 'x-forwarded-host': 'attacker.test' }));
      await mw(request('/other', { ...agent, 'x-forwarded-host': 'attacker.test' }));

      const events = await ingestedEvents();
      expect(events).toHaveLength(2);
      expect(events[0].metadata).toEqual({ path: '/pricing', method: 'GET', host: 'real.example.com' });
      expect(events[1].metadata).toEqual({ path: '/other', method: 'GET' });
    });

    it('falls back to the host header and omits host when none is present', async () => {
      const mw = stealthmark(config);
      await mw(request('/a', { ...agent, host: 'Blog.Example.com:8080' }));
      await mw(request('/b', agent));

      const events = await ingestedEvents();
      expect(events).toHaveLength(2);
      expect(events[0].metadata).toEqual({ path: '/a', method: 'GET', host: 'blog.example.com' });
      expect(events[1].metadata).toEqual({ path: '/b', method: 'GET' });
      expect(events[1]).not.toHaveProperty('site_id');
    });

    it('falls back to STEALTHMARK_SITE_ID', async () => {
      vi.stubEnv('STEALTHMARK_SITE_ID', ENV_SITE_ID);
      const mw = stealthmark(config);
      await mw(request('/', agent));

      expect((await ingestedEvents())[0].site_id).toBe(ENV_SITE_ID);
    });

    it('tags agent_manifest events too', async () => {
      const mw = stealthmark(attributed);
      await mw(request('/.well-known/agent.json', { ...agent, host: 'shop.example.com' }));

      expect((await ingestedEvents())[0]).toMatchObject({
        event_type: 'agent_manifest',
        site_id: SITE_ID,
        metadata: { host: 'shop.example.com' },
      });
    });

    it('tags agent_blocked events with site_id and host', async () => {
      const mw = stealthmark({ ...attributed, agentPolicy: 'block', trustForwardedHost: true });
      const response = expectResponse(await mw(request('/secret', { ...agent, 'x-forwarded-host': 'App.Example.com' }, 'POST')));

      expect(response.status).toBe(403);
      const events = await ingestedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: 'agent_blocked',
        site_id: SITE_ID,
        metadata: { path: '/secret', method: 'POST', host: 'app.example.com' },
      });
    });

    it('withStealthMark tags events with site_id and host', async () => {
      const mw = withStealthMark(() => new Response('ok'), attributed);
      await mw(request('/docs', { ...agent, host: 'Docs.Example.com' }));

      expect((await ingestedEvents())[0]).toMatchObject({
        site_id: SITE_ID,
        metadata: { path: '/docs', method: 'GET', host: 'docs.example.com' },
      });
    });
  });
});

describe('withStealthMark typing', () => {
  it('accepts a middleware typed with a richer framework request without adapters', async () => {
    type FrameworkRequest = { headers: Headers; nextUrl: { pathname: string; searchParams: URLSearchParams }; url: string; method: string; cookies: { get(name: string): { value: string } | undefined } };
    const appMiddleware = async (request: FrameworkRequest) => new Response(request.cookies.get('x')?.value ?? 'ok');
    const wrapped = withStealthMark(appMiddleware, { siteName: 'Typed', reportUsage: false });
    const request: FrameworkRequest = {
      headers: new Headers({ host: 'typed.example' }),
      nextUrl: { pathname: '/', searchParams: new URLSearchParams() },
      url: 'https://typed.example/',
      method: 'GET',
      cookies: { get: () => undefined },
    };
    const response = await wrapped(request);
    expect(response && (await response.text())).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Caching of content-negotiated responses
// ═══════════════════════════════════════════════════════════════════

describe('cache headers of negotiated responses', () => {
  const FIXED_MANIFEST_CACHE = 'public, max-age=60, s-maxage=300';
  const VARY = 'accept, user-agent, x-stealthmark-agent';

  function request(pathname: string, headers: Record<string, string>): { headers: Headers; nextUrl: { pathname: string }; method: string } {
    return { headers: new Headers(headers), nextUrl: { pathname }, method: 'GET' };
  }

  const agentUa = { 'user-agent': 'Mozilla/5.0 GPTBot/1.0', accept: 'text/html' };

  it('keeps the shared-cache policy on the fixed manifest paths, where the body is the same for every caller', async () => {
    const mw = stealthmark({ siteName: 'Cache Site' });
    for (const path of ['/.well-known/agent.json', '/.well-known/ai-plugin.json', '/api/agent-manifest']) {
      const response = expectResponse(await mw(request(path, { accept: 'text/html' })));
      expect(response.headers.get('cache-control')).toBe(FIXED_MANIFEST_CACHE);
      expect(response.headers.get('vary')).toBeNull();
    }
  });

  it('does not let a shared cache store a manifest served on an ordinary path for Accept: application/agent+json', async () => {
    const mw = stealthmark({ siteName: 'Cache Site' });
    const response = expectResponse(await mw(request('/pricing', { ...agentUa, accept: 'application/agent+json' })));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe(VARY);
    expect(response.headers.get('cache-control')).not.toContain('s-maxage');
  });

  it('marks the manifest that agentPolicy "manifest" serves on an ordinary path as private and varying', async () => {
    const mw = stealthmark({ siteName: 'Cache Site', agentPolicy: 'manifest' });
    const response = expectResponse(await mw(request('/', agentUa)));
    expect(response.headers.get('content-type')).toContain('application/agent+json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe(VARY);
  });

  it('marks the agentPolicy "block" 403 as private and varying', async () => {
    const mw = stealthmark({ siteName: 'Cache Site', agentPolicy: 'block' });
    const response = expectResponse(await mw(request('/', agentUa)));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe(VARY);
  });

  it('withStealthMark applies the same rules', async () => {
    const manifestPolicy = withStealthMark(() => new Response('page'), { siteName: 'Cache Site', agentPolicy: 'manifest' });
    const negotiated = expectResponse(await manifestPolicy(request('/pricing', agentUa)));
    expect(negotiated.headers.get('cache-control')).toBe('private, no-store');
    expect(negotiated.headers.get('vary')).toBe(VARY);

    const fixed = expectResponse(await manifestPolicy(request('/.well-known/agent.json', agentUa)));
    expect(fixed.headers.get('cache-control')).toBe(FIXED_MANIFEST_CACHE);
    expect(fixed.headers.get('vary')).toBeNull();

    const blocking = withStealthMark(() => new Response('page'), { siteName: 'Cache Site', agentPolicy: 'block' });
    const blocked = expectResponse(await blocking(request('/', agentUa)));
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('vary')).toBe(VARY);
  });

  it('leaves the response of the host app alone in observe mode', async () => {
    const mw = withStealthMark(() => new Response('page', { headers: { 'cache-control': 'public, max-age=3600' } }), { siteName: 'Cache Site' });
    const response = expectResponse(await mw(request('/', agentUa)));
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('vary')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Dotfiles — 403 by default, opt-in Canary fixture
// ═══════════════════════════════════════════════════════════════════

describe('dotfile policy', () => {
  const ORG = '44444444-4444-4444-8444-444444444444';
  const KID = 'k1a2b3c4';
  // Built at runtime so no key-shaped literal lives in the repository.
  const secret = randomBytes(32);
  const canaryKey = `smck1.${ORG}.${KID}.${secret.toString('base64url')}`;
  const host = { host: 'Shop.Example.com:3000' };

  function request(path: string, headers: Record<string, string> = host) {
    return { headers: new Headers(headers), nextUrl: { pathname: path }, method: 'GET' };
  }

  function canaryToken(body: string): string {
    const url = body.split('\n').find((line) => line.startsWith('HEALTHCHECK_URL='));
    const token = new URL(url?.slice('HEALTHCHECK_URL='.length) ?? '').searchParams.get('t');
    if (!token) throw new Error('fixture has no Canary token');
    return token;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('answers 403 on /.env* and /.git/* by default, before the app and without metering', async () => {
    const existing = vi.fn(() => new Response('app'));
    const wrapped = withStealthMark(existing, { siteName: 'Shop', apiKey: 'sk_live_test', usageEndpoint: 'https://api.test' });
    const mw = stealthmark({ siteName: 'Shop' });
    for (const path of ['/.env', '/.env.local', '/.git', '/.git/config']) {
      for (const response of [expectResponse(await mw(request(path))), expectResponse(await wrapped(request(path, { 'user-agent': 'GPTBot/1.0' })))]) {
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-stealthmark-shield')).toBeTruthy();
      }
    }
    expect(existing).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves look-alike paths to the app', async () => {
    const mw = stealthmark({ siteName: 'Shop' });
    expect(await mw(request('/.github/workflows'))).toBeUndefined();
    expect(await mw(request('/docs/.env'))).toBeUndefined();
  });

  it('serves the synthetic fixture with a Canary token signed by the organization key', async () => {
    const mw = stealthmark({ siteName: 'Shop', dotfiles: 'synthetic_fixture', canaryKey });
    const before = Math.floor(Date.now() / 1000);
    const response = expectResponse(await mw(request('/.env.production')));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect([...response.headers.keys()].filter((name) => name.startsWith('x-stealthmark'))).toEqual([]);

    const body = await response.text();
    const token = canaryToken(body);
    expect(body).toBe(
      [
        '# Este dominio usa @stealthmark/next · https://stealthmark.io/scan?domain=shop.example.com',
        'NODE_ENV=production',
        'APP_URL=https://shop.example.com',
        `HEALTHCHECK_URL=https://stealthmark.io/api/telemetry/canary?t=${token}`,
        '',
      ].join('\n')
    );
    expect(body).not.toContain(secret.toString('base64url'));

    const [payload, signature] = token.split('.');
    expect(createHmac('sha256', secret).update(payload).digest('base64url')).toBe(signature);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims).toMatchObject({ v: 1, kid: KID, org: ORG, host: 'shop.example.com', path: '/.env.production' });
    expect(claims.ts).toBeGreaterThanOrEqual(before);
    expect(claims.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('mints a fresh token per request and reads STEALTHMARK_CANARY_KEY', async () => {
    vi.stubEnv('STEALTHMARK_CANARY_KEY', canaryKey);
    const mw = withStealthMark(() => new Response('app'), { siteName: 'Shop', dotfiles: 'synthetic_fixture' });
    const first = canaryToken(await expectResponse(await mw(request('/.git/config'))).text());
    const second = canaryToken(await expectResponse(await mw(request('/.git/config'))).text());
    expect(first).not.toBe(second);
  });

  it('falls back to 403 with one warning, without the key, when the key is missing or malformed', async () => {
    for (const key of [undefined, canaryKey.slice(0, -1), canaryKey.replace('smck1.', 'smck2.')]) {
      const warn = vi.fn();
      const mw = stealthmark({ siteName: 'Shop', dotfiles: 'synthetic_fixture', canaryKey: key, logger: { warn } });
      expect(expectResponse(await mw(request('/.env'))).status).toBe(403);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain(secret.toString('base64url').slice(0, 20));
    }
  });

  it('falls back to 403 when the request has no host to put in the fixture', async () => {
    const mw = stealthmark({ siteName: 'Shop', dotfiles: 'synthetic_fixture', canaryKey });
    expect(expectResponse(await mw(request('/.env', {}))).status).toBe(403);
  });
});
