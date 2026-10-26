// ═══════════════════════════════════════════════════════════════════
// @stealthmark/next — Next.js Middleware
// Detects self-identified AI agents, serves an agent manifest and meters agent traffic
// ═══════════════════════════════════════════════════════════════════
//
// Usage in your middleware.ts (recommended: withStealthMark keeps your own
// middleware and stamps the StealthMark marker and detection headers on its response):
//
//   import { NextResponse } from 'next/server';
//   import { withStealthMark } from '@stealthmark/next';
//
//   export default withStealthMark(() => NextResponse.next(), {
//     siteName: 'My SaaS',
//     capabilities: [
//       { id: 'search', endpoint: '/api/search', method: 'GET' },
//       { id: 'create-order', endpoint: '/api/orders', method: 'POST', hitl: true },
//     ],
//   });
//
// ═══════════════════════════════════════════════════════════════════

import { buildEventMetadata, createStealthMark, resolveAgentIdentifier, resolveRequestHost } from '@stealthmark/core';
import type { DetectionResult, StealthMarkConfig, StealthMarkInstance } from '@stealthmark/core';
import { canaryFixtureBody, createCanarySigner, isDotfilePath, mintCanaryToken } from './canary.js';
import type { CanarySigner, DotfilePolicy } from './canary.js';

/** StealthMark SDK configuration plus the Next.js-only dotfile policy. */
export type StealthMarkNextConfig = StealthMarkConfig & {
  /** What `/.env*` and `/.git/*` answer: `'block'` (403, the default) or `'synthetic_fixture'` (opt-in). */
  dotfiles?: DotfilePolicy;
  /** Canary key from the StealthMark console, used by `'synthetic_fixture'`. Default: `STEALTHMARK_CANARY_KEY`. */
  canaryKey?: string;
};

/** Minimal type for Next.js request (avoids hard dependency on next types) */
export interface NextLikeRequest {
  headers: Headers;
  nextUrl?: { pathname: string };
  url?: string;
  method?: string;
}

/** Subset of Next.js `NextFetchEvent`: lets the usage flush outlive the response on edge runtimes. */
interface NextLikeFetchEvent {
  waitUntil?: (promise: Promise<unknown>) => void;
}

type AgentHandling = 'passthrough' | 'manifest' | 'block';


/**
 * Well-known paths where agent manifests are conventionally served.
 * The middleware intercepts these paths and serves the manifest automatically.
 */
const MANIFEST_PATHS = new Set([
  '/.well-known/agent.json',
  '/.well-known/ai-plugin.json',
  '/api/agent-manifest',
]);

/** The manifest at a fixed path is the same for every caller, so shared caches may keep it for a few minutes. */
const MANIFEST_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';

/**
 * A response chosen from the request headers (a manifest on an ordinary path, or the block 403) must never be stored as
 * the answer for that URL: it is private, and the headers that decided it are named in Vary.
 */
const NEGOTIATED_CACHE_CONTROL = 'private, no-store';
const NEGOTIATED_VARY = 'accept, user-agent, x-stealthmark-agent';

const CANARY_KEY_WARNING =
  '[stealthmark] dotfiles: "synthetic_fixture" needs a valid Canary key (canaryKey or STEALTHMARK_CANARY_KEY); /.env and /.git/ answer 403 instead.';

/**
 * Creates the minimal, manifest-only Next.js middleware.
 *
 * It answers the manifest paths, `Accept: application/agent+json` requests, the
 * configured `agentPolicy` ('manifest' or 'block') and the `dotfiles` policy, and meters agent requests.
 * For every other request it returns `undefined`, so Next.js continues the chain and
 * serves your page untouched. Because nothing is returned, it cannot add the marker or
 * detection headers to those pages: use `withStealthMark` when you want them.
 *
 * @example
 * ```typescript
 * // middleware.ts
 * import { stealthmark } from '@stealthmark/next';
 *
 * export default stealthmark({
 *   siteName: 'My SaaS',
 *   capabilities: [
 *     { id: 'search', endpoint: '/api/search', method: 'GET' },
 *   ],
 * });
 *
 * export const config = {
 *   matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
 * };
 * ```
 *
 * @param config - StealthMark SDK configuration
 * @returns A Next.js middleware function
 */
export function stealthmark(config: StealthMarkNextConfig) {
  const sm = createStealthMark(config);
  const canary = resolveCanarySigner(config);

  return async function middleware(request: NextLikeRequest, event?: NextLikeFetchEvent): Promise<Response | undefined> {
    const pathname = request.nextUrl?.pathname ?? new URL(request.url ?? '/', 'http://localhost').pathname;
    if (isDotfilePath(pathname)) return answerDotfile(sm, canary, request, pathname);
    const detection = sm.detect(request.headers);
    const handling = decideAgentHandling(sm, request, detection, pathname);

    if (detection.isAgent) {
      meterAgentRequest(sm, request, detection, pathname, handling);
      scheduleUsageFlush(sm, event);
    }

    if (handling === 'manifest') return createAgentResponse(sm.manifestJson, sm.responseHeaders, detection, !MANIFEST_PATHS.has(pathname));
    if (handling === 'block') return createBlockedResponse(sm.responseHeaders);

    return undefined;
  };
}

/**
 * Higher-order middleware wrapper for use with existing Next.js middleware.
 *
 * This is the recommended entry point. It runs your middleware (use
 * `() => NextResponse.next()` when you have none), keeps its response, and stamps
 * the `x-stealthmark-*` marker headers plus the agent detection headers on it. Manifest, block and dotfile
 * responses are served before your middleware runs. If your middleware returns
 * nothing, the chain continues untouched and no headers are added.
 *
 * @example
 * ```typescript
 * // middleware.ts
 * import { withStealthMark } from '@stealthmark/next';
 * import { NextResponse } from 'next/server';
 * import type { NextRequest } from 'next/server';
 *
 * function myMiddleware(request: NextRequest) {
 *   // Your existing middleware logic
 *   return NextResponse.next();
 * }
 *
 * export default withStealthMark(myMiddleware, {
 *   siteName: 'My SaaS',
 *   capabilities: [...],
 * });
 * ```
 */
export function withStealthMark<Req extends NextLikeRequest = NextLikeRequest>(
  existingMiddleware: (request: Req) => Response | undefined | Promise<Response | undefined>,
  config: StealthMarkNextConfig
) {
  const sm = createStealthMark(config);
  const canary = resolveCanarySigner(config);

  return async function middleware(request: Req, event?: NextLikeFetchEvent): Promise<Response | undefined> {
    const pathname = request.nextUrl?.pathname ?? new URL(request.url ?? '/', 'http://localhost').pathname;
    if (isDotfilePath(pathname)) return answerDotfile(sm, canary, request, pathname);
    const detection = sm.detect(request.headers);
    const handling = decideAgentHandling(sm, request, detection, pathname);

    if (detection.isAgent) {
      meterAgentRequest(sm, request, detection, pathname, handling);
      scheduleUsageFlush(sm, event);
    }

    if (handling === 'manifest') return createAgentResponse(sm.manifestJson, sm.responseHeaders, detection, !MANIFEST_PATHS.has(pathname));
    if (handling === 'block') return createBlockedResponse(sm.responseHeaders);

    // Observe: the site answers normally; agents only get tagged
    const response = await existingMiddleware(request);
    if (response === undefined) return undefined;
    applyHeaders(response, sm.responseHeaders);
    if (detection.isAgent) applyDetectionHeaders(response, detection);
    return response;
  };
}

/**
 * Recommended `config.matcher` for the middleware.
 * Excludes static assets and internal Next.js routes.
 */
export const defaultMatcher = ['/((?!_next/static|_next/image|favicon.ico).*)'];

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Meters one agent request through the usage reporter.
 */
function resolveMeteredPath(request: NextLikeRequest, pathname: string): string {
  if (pathname === '/scan' && request.url) {
    try {
      const u = new URL(request.url, 'http://localhost');
      const dom = u.searchParams.get('domain')?.trim().toLowerCase();
      if (dom && /^[a-z0-9.-]{1,120}$/.test(dom)) {
        return `/scan?domain=${dom}`;
      }
    } catch {
      // ignore malformed URL
    }
  }
  return pathname;
}

function meterAgentRequest(
  sm: StealthMarkInstance,
  request: NextLikeRequest,
  detection: DetectionResult,
  pathname: string,
  handling: AgentHandling
): void {
  const eventType = MANIFEST_PATHS.has(pathname) ? 'agent_manifest' : handling === 'block' ? 'agent_blocked' : 'agent_request';
  sm.recordAgentEvent({
    event_type: eventType,
    agent_identifier: resolveAgentIdentifier(request.headers, detection),
    metadata: buildEventMetadata({
      path: resolveMeteredPath(request, pathname),
      method: request.method ?? 'GET',
      host: resolveRequestHost(request.headers, { trustForwardedHost: sm.trustForwardedHost }),
    }),
  });
}

/** Manifest paths and explicit `Accept: application/agent+json` always win; then the configured policy decides. */
function decideAgentHandling(
  sm: StealthMarkInstance,
  request: NextLikeRequest,
  detection: DetectionResult,
  pathname: string
): AgentHandling {
  if (MANIFEST_PATHS.has(pathname)) return 'manifest';
  if (!detection.isAgent) return 'passthrough';
  if ((request.headers.get('accept') ?? '').includes('application/agent+json')) return 'manifest';
  if (sm.agentPolicy === 'block') return 'block';
  if (sm.agentPolicy === 'manifest') return 'manifest';
  return 'passthrough';
}

/** On edge runtimes the response may end before the batched usage POST; `waitUntil` keeps it alive. */
function scheduleUsageFlush(sm: StealthMarkInstance, event?: NextLikeFetchEvent): void {
  if (event?.waitUntil && sm.usage.active) {
    event.waitUntil(sm.usage.flush());
  }
}

function applyHeaders(response: Response, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
}

function applyDetectionHeaders(response: Response, detection: DetectionResult): void {
  response.headers.set('x-stealthmark-agent-detected', 'true');
  if (detection.agentId) response.headers.set('x-stealthmark-agent-id', detection.agentId);
}

function createBlockedResponse(headers: Record<string, string>): Response {
  const response = new Response(
    JSON.stringify({ error: 'agent_blocked', message: 'This site does not accept automated agent traffic.' }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': NEGOTIATED_CACHE_CONTROL,
        vary: NEGOTIATED_VARY,
      },
    }
  );
  applyHeaders(response, headers);
  return response;
}

/** Without a usable key the fixture is never served: 'synthetic_fixture' falls back to 'block' with one warning. */
function resolveCanarySigner(config: StealthMarkNextConfig): CanarySigner | null {
  if (config.dotfiles !== 'synthetic_fixture') return null;
  const envKey = typeof process === 'undefined' || !process.env ? undefined : process.env.STEALTHMARK_CANARY_KEY;
  const signer = createCanarySigner(config.canaryKey ?? envKey);
  if (signer === null && config.logger !== false) (config.logger ?? console).warn(CANARY_KEY_WARNING);
  return signer;
}

/** The fixture carries no marker headers, so it reads like the file it stands in for. */
async function answerDotfile(
  sm: StealthMarkInstance,
  canary: CanarySigner | null,
  request: NextLikeRequest,
  pathname: string
): Promise<Response> {
  const host = canary && resolveRequestHost(request.headers, { trustForwardedHost: sm.trustForwardedHost });
  if (!canary || !host) {
    const response = new Response('Forbidden', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
    applyHeaders(response, sm.responseHeaders);
    return response;
  }
  return new Response(canaryFixtureBody(host, await mintCanaryToken(canary, host, pathname)), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function createAgentResponse(
  manifestJson: string,
  headers: Record<string, string>,
  detection: DetectionResult,
  negotiated: boolean
): Response {
  const response = new Response(manifestJson, {
    status: 200,
    headers: {
      'content-type': 'application/agent+json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'cache-control': negotiated ? NEGOTIATED_CACHE_CONTROL : MANIFEST_CACHE_CONTROL,
      ...(negotiated ? { vary: NEGOTIATED_VARY } : {}),
      'x-stealthmark-route': 'DUAL_DOOR_AGENT_FASTPATH',
      ...headers,
    },
  });
  if (detection.isAgent) applyDetectionHeaders(response, detection);
  return response;
}
