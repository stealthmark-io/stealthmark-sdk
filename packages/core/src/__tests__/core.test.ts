import { describe, it, expect, vi } from 'vitest';
import { detectAgent } from '../detect-agent.js';
import { generateManifest, serializeManifest } from '../manifest.js';
import { createStealthMark } from '../create.js';
import type { StealthMarkConfig } from '../types.js';

// ═══════════════════════════════════════════════════════════════════
// detectAgent — Agent Detection Engine
// ═══════════════════════════════════════════════════════════════════

describe('detectAgent', () => {
  it('detects agent via application/agent+json Accept header', () => {
    const result = detectAgent({ accept: 'application/agent+json', 'user-agent': 'curl/8.0' });
    expect(result.isAgent).toBe(true);
    expect(result.method).toBe('accept-header');
  });

  it('detects agent via x-stealthmark-agent header', () => {
    const result = detectAgent({ 'x-stealthmark-agent': 'example-agent-v1', 'user-agent': 'node-fetch' });
    expect(result.isAgent).toBe(true);
    expect(result.agentId).toBe('example-agent-v1');
    expect(result.method).toBe('stealthmark-header');
  });

  it('does NOT flag JSON-only Accept: the site own API calls are not agents', () => {
    const result = detectAgent({ accept: 'application/json', 'user-agent': 'python-requests/2.31' });
    expect(result.isAgent).toBe(false);
    expect(result.method).toBe('none');
  });

  it('does NOT flag browser Accept with both JSON and HTML', () => {
    const result = detectAgent({
      accept: 'text/html,application/xhtml+xml,application/json',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    expect(result.isAgent).toBe(false);
    expect(result.method).toBe('none');
  });

  it('detects known agent User-Agent patterns (GPTBot)', () => {
    const result = detectAgent({ accept: 'text/html', 'user-agent': 'Mozilla/5.0 GPTBot/1.0' });
    expect(result.isAgent).toBe(true);
    expect(result.method).toBe('user-agent');
  });

  it('detects known agent User-Agent patterns (ClaudeBot)', () => {
    const result = detectAgent({ accept: '*/*', 'user-agent': 'ClaudeBot/1.0' });
    expect(result.isAgent).toBe(true);
    expect(result.method).toBe('user-agent');
  });

  it.each([
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', 'OAI-SearchBot'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot', 'ChatGPT-User'],
    ['Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'Claude-User'],
    ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)', 'Claude-SearchBot'],
    ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'Meta-ExternalAgent'],
    ['Mozilla/5.0 (Macintosh) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', 'Amazonbot'],
    ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
    ['Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'Perplexity-User'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'PerplexityBot'],
    ['Mozilla/5.0 (compatible; Google-CloudVertexBot; +https://cloud.google.com/vertex-ai)', 'Google-CloudVertexBot'],
    ['Mozilla/5.0 (compatible; DuckAssistBot/1.2; +http://duckduckgo.com/duckassistbot.html)', 'DuckAssistBot'],
    ['Mozilla/5.0 (compatible; YouBot/1.0; +https://about.you.com/youbot/)', 'YouBot'],
  ])('detects vendor crawler token in %s', (userAgent, agentId) => {
    const result = detectAgent({ accept: 'text/html', 'user-agent': userAgent });
    expect(result.isAgent).toBe(true);
    expect(result.method).toBe('user-agent');
    expect(result.agentId).toBe(agentId);
  });

  it('does not match Google-Extended, which is a robots.txt token and never a User-Agent', () => {
    const result = detectAgent({ accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Google-Extended)' });
    expect(result.isAgent).toBe(false);
  });

  it('does not match Applebot-Extended, which is a robots.txt token and never a User-Agent', () => {
    const result = detectAgent({ accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; Applebot-Extended/0.1)' });
    expect(result.isAgent).toBe(false);
  });

  it.each(['AutonomousAgent/1.0', 'Example-Agent/2.0', 'Devin-Agent/1.0', 'Windsurf-Agent/1.0', 'Cursor-Agent/1.0'])(
    'no longer treats the unverifiable token %s as an agent',
    (userAgent) => {
      expect(detectAgent({ accept: 'text/html', 'user-agent': userAgent }).isAgent).toBe(false);
    }
  );

  it('keeps self-declared identifiers detectable', () => {
    const result = detectAgent({ accept: '*/*', 'user-agent': 'MCP-Client/1.0' });
    expect(result.isAgent).toBe(true);
    expect(result.agentId).toBe('MCP-Client');
  });

  it('detects custom extra patterns', () => {
    const result = detectAgent(
      { accept: 'text/html', 'user-agent': 'MyCompanyBot/2.0' },
      ['MyCompanyBot']
    );
    expect(result.isAgent).toBe(true);
    expect(result.method).toBe('user-agent');
  });

  it('returns isAgent=false for a normal browser', () => {
    const result = detectAgent({
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0',
    });
    expect(result.isAgent).toBe(false);
    expect(result.method).toBe('none');
  });

  it('works with native Headers object', () => {
    const headers = new Headers();
    headers.set('accept', 'application/agent+json');
    headers.set('user-agent', 'test');
    const result = detectAgent(headers);
    expect(result.isAgent).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// generateManifest — Manifest Generation
// ═══════════════════════════════════════════════════════════════════

describe('generateManifest', () => {
  const baseConfig: StealthMarkConfig = {
    siteName: 'Test SaaS',
    origin: 'https://test.example.com',
    version: '2.0.0',
    contactEmail: 'dev@test.com',
    capabilities: [
      { id: 'search', endpoint: '/api/search', method: 'GET', description: 'Search products' },
      { id: 'order', endpoint: '/api/orders', method: 'POST', hitl: true },
    ],
  };

  it('generates a valid manifest with all fields', () => {
    const manifest = generateManifest(baseConfig);
    expect(manifest).not.toHaveProperty('$schema');
    expect(manifest.name).toBe('Test SaaS');
    expect(manifest.origin).toBe('https://test.example.com');
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.contact).toBe('dev@test.com');
    expect(manifest.capabilities).toHaveLength(2);
    expect(manifest.capabilities[0].id).toBe('search');
    expect(manifest.capabilities[1].hitl).toBe(true);
  });

  it('emits the protocol identifier and the observe policy by default', () => {
    const manifest = generateManifest(baseConfig);
    expect(manifest.protocol).toBe('stealthmark_agent_governance_v1');
    expect(manifest.agent_policy.mode).toBe('observe');
    expect(manifest.agent_policy.identification.headers).toContain('x-stealthmark-agent');
    expect(JSON.stringify(manifest)).not.toMatch(/defcon|kya|passport|dual_door/i);
  });

  it('advertises the configured agent policy', () => {
    const manifest = generateManifest({ ...baseConfig, agentPolicy: 'block' });
    expect(manifest.agent_policy.mode).toBe('block');
    expect(manifest.agent_policy.conduct.length).toBeGreaterThan(0);
  });

  it('serializes to valid JSON', () => {
    const manifest = generateManifest(baseConfig);
    const json = serializeManifest(manifest);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe('Test SaaS');
    expect(parsed.capabilities).toHaveLength(2);
  });

  it('omits origin when not configured', () => {
    const manifest = generateManifest({ siteName: 'Minimal' });
    expect(manifest).not.toHaveProperty('origin');
    expect(JSON.parse(serializeManifest(manifest))).not.toHaveProperty('origin');
  });

  it('does not claim an agent id registry in the conduct rules', () => {
    const manifest = generateManifest(baseConfig);
    expect(manifest.agent_policy.conduct[0]).toBe(
      'Identify yourself with a descriptive User-Agent. You may also send your agent name in the x-stealthmark-agent header.'
    );
    expect(JSON.stringify(manifest.agent_policy.conduct)).not.toMatch(/agent id/i);
  });

  it('omits contact when no email provided', () => {
    const manifest = generateManifest({ siteName: 'Minimal', capabilities: [] });
    expect(manifest.contact).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// createStealthMark — Full Instance
// ═══════════════════════════════════════════════════════════════════

describe('createStealthMark', () => {
  it('creates a fully configured instance', () => {
    const sm = createStealthMark({
      siteName: 'My App',
      capabilities: [{ id: 'test', endpoint: '/api/test', method: 'GET' }],
    });

    expect(sm.manifest.name).toBe('My App');
    expect(sm.manifestJson).toContain('"My App"');
    expect(sm.responseHeaders['x-stealthmark-shield']).toBe('ACTIVE');
    expect(sm.responseHeaders['x-stealthmark-agent-policy']).toBe('observe');
  });

  it('detect() proxies to detectAgent correctly', () => {
    const sm = createStealthMark({ siteName: 'Test' });
    const result = sm.detect({ accept: 'application/agent+json', 'user-agent': 'test' });
    expect(result.isAgent).toBe(true);
  });

  it('makes no network call when an API key is set but no agent request is recorded', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sm = createStealthMark({ siteName: 'Test', apiKey: 'sm_test_key_123' });
    sm.detect({ 'user-agent': 'Mozilla/5.0' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('merges custom response headers', () => {
    const sm = createStealthMark({
      siteName: 'Test',
      headers: { 'x-custom': 'value' },
    });
    expect(sm.responseHeaders['x-custom']).toBe('value');
    expect(sm.responseHeaders['x-stealthmark-shield']).toBe('ACTIVE');
  });
});
