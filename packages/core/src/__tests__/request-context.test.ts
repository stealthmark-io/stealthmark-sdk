import { describe, expect, it } from 'vitest';
import { createStealthMark } from '../create.js';
import { buildEventMetadata, MAX_HOST_LENGTH, normalizeHost, resolveRequestHost } from '../request-context.js';

describe('normalizeHost', () => {
  it('lowercases the host', () => {
    expect(normalizeHost('Example.COM')).toBe('example.com');
  });

  it('strips the port', () => {
    expect(normalizeHost('example.com:8443')).toBe('example.com');
    expect(normalizeHost('localhost:3000')).toBe('localhost');
  });

  it('takes the first entry of a forwarded host list', () => {
    expect(normalizeHost('Shop.Example.com, internal.proxy:8080, other.test')).toBe('shop.example.com');
  });

  it('keeps bracketed IPv6 literals and strips their port', () => {
    expect(normalizeHost('[::1]:3000')).toBe('[::1]');
    expect(normalizeHost('[2001:DB8::7]')).toBe('[2001:db8::7]');
  });

  it('keeps IPv4 addresses without the port', () => {
    expect(normalizeHost('203.0.113.9:80')).toBe('203.0.113.9');
  });

  it('strips one trailing dot of a fully qualified name', () => {
    expect(normalizeHost('example.com.')).toBe('example.com');
  });

  it('returns undefined when the value is missing or empty', () => {
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost(null)).toBeUndefined();
    expect(normalizeHost('')).toBeUndefined();
    expect(normalizeHost('   ')).toBeUndefined();
    expect(normalizeHost(', other.test')).toBeUndefined();
  });

  it('returns undefined for values that are not a hostname', () => {
    expect(normalizeHost('exa mple.com')).toBeUndefined();
    expect(normalizeHost('example.com/path')).toBeUndefined();
    expect(normalizeHost('<script>alert(1)</script>')).toBeUndefined();
    expect(normalizeHost('[::1')).toBeUndefined();
    expect(normalizeHost('::1')).toBeUndefined();
    expect(normalizeHost(':8080')).toBeUndefined();
  });

  it('caps the host at 253 characters', () => {
    const host = normalizeHost(`${'a'.repeat(300)}.com`);
    expect(host).toHaveLength(MAX_HOST_LENGTH);
    expect(MAX_HOST_LENGTH).toBe(253);
  });
});

describe('resolveRequestHost', () => {
  const trusting = { trustForwardedHost: true };

  it('reads the host header and ignores a spoofed x-forwarded-host by default', () => {
    const headers = new Headers({ host: 'Real.Example.com:3000', 'x-forwarded-host': 'attacker.test' });
    expect(resolveRequestHost(headers)).toBe('real.example.com');
    expect(resolveRequestHost(headers, {})).toBe('real.example.com');
    expect(resolveRequestHost(headers, { trustForwardedHost: false })).toBe('real.example.com');
  });

  it('returns undefined by default when only x-forwarded-host is present', () => {
    expect(resolveRequestHost(new Headers({ 'x-forwarded-host': 'attacker.test' }))).toBeUndefined();
  });

  it('prefers the first x-forwarded-host value over the host header when trustForwardedHost is true', () => {
    const headers = new Headers({ host: 'internal.vercel.app', 'x-forwarded-host': 'Shop.Example.com:443, edge.proxy' });
    expect(resolveRequestHost(headers, trusting)).toBe('shop.example.com');
  });

  it('falls back to the host header', () => {
    expect(resolveRequestHost(new Headers({ host: 'Blog.Example.com:3000' }))).toBe('blog.example.com');
    expect(resolveRequestHost(new Headers({ host: 'Blog.Example.com:3000' }), trusting)).toBe('blog.example.com');
  });

  it('falls back to the host header when a trusted x-forwarded-host is unusable', () => {
    expect(
      resolveRequestHost(new Headers({ host: 'blog.example.com', 'x-forwarded-host': 'not a host' }), trusting)
    ).toBe('blog.example.com');
  });

  it('reads plain header records', () => {
    expect(resolveRequestHost({ 'x-forwarded-host': 'App.Example.com', host: 'internal' }, trusting)).toBe(
      'app.example.com'
    );
    expect(resolveRequestHost({ 'x-forwarded-host': 'App.Example.com', host: 'internal' })).toBe('internal');
    expect(resolveRequestHost({ host: 'App.Example.com:80' })).toBe('app.example.com');
  });

  it('returns undefined when no header carries a host', () => {
    expect(resolveRequestHost(new Headers())).toBeUndefined();
    expect(resolveRequestHost({})).toBeUndefined();
  });
});

describe('createStealthMark trustForwardedHost', () => {
  const base = { siteName: 'Site', reportUsage: false };

  it('does not trust x-forwarded-host unless configured', () => {
    expect(createStealthMark(base).trustForwardedHost).toBe(false);
    expect(createStealthMark({ ...base, trustForwardedHost: false }).trustForwardedHost).toBe(false);
  });

  it('exposes trustForwardedHost when configured', () => {
    expect(createStealthMark({ ...base, trustForwardedHost: true }).trustForwardedHost).toBe(true);
  });
});

describe('buildEventMetadata', () => {
  it('carries path, method and host', () => {
    expect(buildEventMetadata({ path: '/pricing', method: 'POST', host: 'shop.example.com' })).toEqual({
      path: '/pricing',
      method: 'POST',
      host: 'shop.example.com',
    });
  });

  it('omits the host when absent and defaults the method to GET', () => {
    expect(buildEventMetadata({ path: '/' })).toEqual({ path: '/', method: 'GET' });
  });

  it('shortens the path, never the host, to stay within the 1024-byte limit', () => {
    const host = `${'h'.repeat(240)}.com`;
    const metadata = buildEventMetadata({ path: '\u0001'.repeat(300), method: 'GET', host });

    expect(metadata.host).toBe(host);
    expect(metadata.method).toBe('GET');
    expect(metadata.path.length).toBeGreaterThan(0);
    expect(metadata.path.length).toBeLessThan(200);
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThanOrEqual(1024);
  });

  it('counts multi-byte characters in the byte budget', () => {
    const host = `${'h'.repeat(240)}.com`;
    const metadata = buildEventMetadata({ path: '\u{1F600}'.repeat(200), method: 'GET', host });

    expect(metadata.host).toBe(host);
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThanOrEqual(1024);
  });

  it('truncates a long ordinary path to the ingest per-value limit of 200 characters', () => {
    const metadata = buildEventMetadata({ path: `/${'a'.repeat(500)}`, host: 'shop.example.com' });
    expect(metadata.path).toHaveLength(200);
    expect(metadata.host).toBe('shop.example.com');
  });
});

describe('resolveAgentIdentifier', () => {
  it('groups crawler versions under the canonical detected name instead of the raw User-Agent', async () => {
    const { resolveAgentIdentifier } = await import('../usage-reporter.js');
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
    expect(resolveAgentIdentifier(new Headers({ 'user-agent': ua }), { isAgent: true, agentId: 'GPTBot', method: 'user-agent' })).toBe('GPTBot');
  });

  it('prefers the explicit x-stealthmark-agent id', async () => {
    const { resolveAgentIdentifier } = await import('../usage-reporter.js');
    expect(resolveAgentIdentifier(new Headers({ 'x-stealthmark-agent': 'acme-bot', 'user-agent': 'GPTBot/1.2' }), { isAgent: true, agentId: 'GPTBot', method: 'stealthmark-header' })).toBe('acme-bot');
  });

  it('falls back to the User-Agent when detection has no canonical name', async () => {
    const { resolveAgentIdentifier } = await import('../usage-reporter.js');
    expect(resolveAgentIdentifier({ 'user-agent': 'SomeAgent/1.0' }, { isAgent: true, method: 'accept-header' })).toBe('SomeAgent/1.0');
  });
});
