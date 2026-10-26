import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runInit, detectFramework } from '../commands/init.js';
import { runVerify } from '../commands/verify.js';
import { createStealthMark } from '@stealthmark/core';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import type { AddressInfo } from 'net';

describe('@stealthmark/cli — init command', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthmark-cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writePackageJson(content: Record<string, unknown>): void {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(content));
  }

  it('detects Next.js from package.json dependency', () => {
    writePackageJson({ dependencies: { next: '^15.0.0' } });
    expect(detectFramework(tempDir)).toBe('next');
  });

  it('detects Express and Fastify as different frameworks', () => {
    writePackageJson({ dependencies: { express: '^4.18.0' } });
    expect(detectFramework(tempDir)).toBe('express');

    writePackageJson({ dependencies: { fastify: '^5.0.0' } });
    expect(detectFramework(tempDir)).toBe('fastify');
  });

  it('scaffolds middleware.ts for a Next.js app', () => {
    writePackageJson({ name: 'my-agent-site', dependencies: { next: '^15.0.0' } });

    const result = runInit({ cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.framework).toBe('next');
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.nextSteps.join(' ')).toContain('/.well-known/agent.json');

    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain("import { stealthmark } from '@stealthmark/next'");
    expect(content).toContain('my-agent-site');
  });

  it('emits an empty capabilities list when no routes are discovered', () => {
    writePackageJson({ name: 'no-routes', dependencies: { next: '^15.0.0' } });

    const result = runInit({ cwd: tempDir });
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(result.capabilitiesCount).toBe(0);
    expect(content).toContain('capabilities: []');
    expect(content).not.toContain('/api/search');
    expect(content).not.toContain('Primary search endpoint');
  });

  it('lists discovered App Router handlers without inventing pricing or human approval', () => {
    writePackageJson({ name: 'with-routes', dependencies: { next: '^15.0.0' } });
    const routeDir = path.join(tempDir, 'app', 'api', 'orders');
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'route.ts'), 'export const POST = async () => new Response("ok");');

    const result = runInit({ cwd: tempDir });
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(result.capabilitiesCount).toBe(1);
    expect(content).toContain('"endpoint": "/api/orders"');
    expect(content).toContain('"method": "POST"');
    expect(content).not.toContain('pricing');
    expect(content).not.toContain('hitl');
  });

  it('scaffolds stealthmark.middleware.ts for an Express app and says how to mount it', () => {
    writePackageJson({ name: 'my-express-api', dependencies: { express: '^4.18.0' } });

    const result = runInit({ cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.framework).toBe('express');
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.nextSteps).toContain('Add app.use(stealthmarkMiddleware) before your routes');

    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain("import { stealthmark } from '@stealthmark/express'");
    expect(content).toContain('export const stealthmarkMiddleware');
    expect(content).toContain('capabilities: []');
    expect(content).not.toContain('agentShield');
  });

  it('scaffolds a Fastify hook for a Fastify app', () => {
    writePackageJson({ name: 'my-fastify-api', dependencies: { fastify: '^5.0.0' } });

    const result = runInit({ cwd: tempDir });
    expect(result.success).toBe(true);
    expect(result.framework).toBe('fastify');
    expect(result.nextSteps.join(' ')).toContain("fastify.addHook('preHandler', stealthmarkHook)");

    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain("import { stealthmarkFastify } from '@stealthmark/express'");
    expect(content).toContain('export const stealthmarkHook');
  });

  it('fails without writing a file when no supported framework is detected', () => {
    writePackageJson({ name: 'plain-node', dependencies: {} });

    const result = runInit({ cwd: tempDir });
    expect(result.success).toBe(false);
    expect(result.framework).toBe('unknown');
    expect(result.message).toContain('No Next.js, Express or Fastify project detected');
    expect(fs.readdirSync(tempDir)).toEqual(['package.json']);
  });

  it('refuses to overwrite an existing file without --force', () => {
    writePackageJson({ name: 'existing', dependencies: { express: '^4.18.0' } });
    fs.writeFileSync(path.join(tempDir, 'stealthmark.middleware.ts'), '// mine');

    const blocked = runInit({ cwd: tempDir });
    expect(blocked.success).toBe(false);
    expect(fs.readFileSync(path.join(tempDir, 'stealthmark.middleware.ts'), 'utf8')).toBe('// mine');

    expect(runInit({ cwd: tempDir, force: true }).success).toBe(true);
  });
});

describe('@stealthmark/cli — verify command', () => {
  const servers: http.Server[] = [];

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  function stealthmarkHandler(capabilities: Array<{ id: string; endpoint: string; method: 'GET' }>): http.RequestListener {
    const sm = createStealthMark({ siteName: 'Fixture Site', capabilities });
    return (req, res) => {
      const wantsManifest = req.url === '/.well-known/agent.json' || (req.headers.accept ?? '').includes('application/agent+json');
      if (wantsManifest) {
        res.writeHead(200, { 'content-type': 'application/agent+json; charset=utf-8', ...sm.responseHeaders });
        res.end(sm.manifestJson);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    };
  }

  it('passes all three checks against a site that runs the StealthMark middleware', async () => {
    const url = await serve(stealthmarkHandler([{ id: 'search', endpoint: '/api/search', method: 'GET' }]));

    const report = await runVerify(url);
    expect(report.overallPassed).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'Manifest at /.well-known/agent.json',
      'Manifest via Accept: application/agent+json',
      'x-stealthmark-shield header',
    ]);
    expect(report.checks[0].details).toContain('1 capability');
    expect(report.checks[0].details).not.toContain('1 capabilities');
  });

  it('pluralizes the capability count', async () => {
    const url = await serve(
      stealthmarkHandler([
        { id: 'a', endpoint: '/api/a', method: 'GET' },
        { id: 'b', endpoint: '/api/b', method: 'GET' },
      ])
    );

    const report = await runVerify(url);
    expect(report.checks[0].details).toContain('2 capabilities');
  });

  it('does not pass a plain server that answers every path with arbitrary JSON', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hello":"world"}');
    });

    const report = await runVerify(url);
    expect(report.overallPassed).toBe(false);
    expect(report.checks.every((c) => !c.passed)).toBe(true);
    expect(report.checks[0].details).toContain('missing name, protocol or a capabilities array');
  });

  it('fails the manifest check on an HTML 200 without a parse error message', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });

    const report = await runVerify(url);
    expect(report.checks[0].passed).toBe(false);
    expect(report.checks[0].details).toBe('Content-Type is text/html, expected JSON');
  });

  it('reports a JSON content type with an unparseable body as not JSON', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>');
    });

    const report = await runVerify(url);
    expect(report.checks[0].details).toBe('Response is not JSON');
  });

  it('fails the marker header check for a site that serves its own manifest without StealthMark', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/agent+json' });
      res.end(JSON.stringify({ name: 'Own', protocol: 'own_v1', capabilities: [] }));
    });

    const report = await runVerify(url);
    expect(report.checks[0].passed).toBe(true);
    expect(report.checks[1].passed).toBe(true);
    expect(report.checks[2].passed).toBe(false);
    expect(report.overallPassed).toBe(false);
  });

  it('reports a network error for every affected check when the host is unreachable', async () => {
    const url = await serve(() => undefined);
    await new Promise((resolve) => servers.pop()?.close(resolve));

    const report = await runVerify(url);
    expect(report.overallPassed).toBe(false);
    expect(report.checks).toHaveLength(3);
    expect(report.checks.every((c) => c.details.startsWith('Network error:'))).toBe(true);
  });
});
