import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { discoverCapabilities } from '../auto-discovery.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Route Auto-Discovery Engine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthmark-discovery-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when no api directory exists', () => {
    const caps = discoverCapabilities({ rootDir: tempDir });
    expect(caps).toEqual([]);
  });

  it('scans App Router routes and detects GET and POST methods', () => {
    const apiDir = path.join(tempDir, 'app', 'api', 'search');
    fs.mkdirSync(apiDir, { recursive: true });

    fs.writeFileSync(
      path.join(apiDir, 'route.ts'),
      `
      export async function GET(req: Request) { return new Response("ok"); }
      export async function POST(req: Request) { return new Response("created"); }
      `
    );

    const caps = discoverCapabilities({ rootDir: tempDir });
    expect(caps).toHaveLength(2);

    const getCap = caps.find((c) => c.method === 'GET');
    expect(getCap).toBeDefined();
    expect(getCap?.endpoint).toBe('/api/search');
    expect(getCap?.id).toBe('search-get');
    expect(getCap?.hitl).toBeUndefined();
    expect(getCap).not.toHaveProperty('pricing');

    const postCap = caps.find((c) => c.method === 'POST');
    expect(postCap).toBeDefined();
    expect(postCap?.endpoint).toBe('/api/search');
    expect(postCap?.id).toBe('search-post');
  });

  it('flags routes as HITL only when hitlKeywords is passed', () => {
    const checkoutDir = path.join(tempDir, 'src', 'app', 'api', 'checkout');
    fs.mkdirSync(checkoutDir, { recursive: true });

    fs.writeFileSync(
      path.join(checkoutDir, 'route.ts'),
      `
      export async function POST(req: Request) { return new Response("order created"); }
      `
    );

    const withoutKeywords = discoverCapabilities({ rootDir: tempDir });
    expect(withoutKeywords).toHaveLength(1);
    expect(withoutKeywords[0].endpoint).toBe('/api/checkout');
    expect(withoutKeywords[0].hitl).toBeUndefined();

    const withKeywords = discoverCapabilities({ rootDir: tempDir, hitlKeywords: ['checkout'] });
    expect(withKeywords).toHaveLength(1);
    expect(withKeywords[0].hitl).toBe(true);
  });

  it('detects methods exported as const and through export lists', () => {
    const constDir = path.join(tempDir, 'app', 'api', 'orders');
    const listDir = path.join(tempDir, 'app', 'api', 'items');
    fs.mkdirSync(constDir, { recursive: true });
    fs.mkdirSync(listDir, { recursive: true });

    fs.writeFileSync(path.join(constDir, 'route.ts'), `export const POST = async (req: Request) => new Response('ok');`);
    fs.writeFileSync(
      path.join(listDir, 'route.ts'),
      `const handler = async () => new Response('ok');\nexport { handler as GET, handler as DELETE };`
    );

    const caps = discoverCapabilities({ rootDir: tempDir });
    const summary = caps.map((c) => `${c.method} ${c.endpoint}`).sort();
    expect(summary).toEqual(['DELETE /api/items', 'GET /api/items', 'POST /api/orders']);
  });

  it('skips route files whose HTTP methods cannot be determined instead of inventing GET', () => {
    const dir = path.join(tempDir, 'app', 'api', 'mystery');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'route.ts'), `export default function helper() {}`);

    expect(discoverCapabilities({ rootDir: tempDir })).toEqual([]);
  });

  it('does not scan Pages Router api files', () => {
    const dir = path.join(tempDir, 'pages', 'api');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'route.ts'), `export async function GET() {}`);

    expect(discoverCapabilities({ rootDir: tempDir })).toEqual([]);
  });
});
