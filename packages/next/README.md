# @stealthmark/next

**Next.js middleware that detects self-identified AI agents, serves an agent manifest and meters agent traffic.**

> Detects only agents that identify themselves. It does not detect stealth bots and is not a security control.

By default (`agentPolicy: 'observe'`) your page content is unchanged; `withStealthMark` only adds the informational `x-stealthmark-shield` and `x-stealthmark-agent-policy` response headers to every response of your middleware, human visitors included. Requests from agents that identify themselves are tagged with an `x-stealthmark-agent-detected` response header and, if you set an API key, metered. Agents get the JSON manifest at `/.well-known/agent.json`, or on any path when they send `Accept: application/agent+json`. Set `agentPolicy: 'manifest'` to serve the manifest to detected agents instead of the page, or `'block'` to answer them with 403.

The manifest is StealthMark's own format. It is not an A2A Agent Card, an MCP server manifest or an adopted standard.

## Installation

```bash
npm install @stealthmark/next @stealthmark/core
```

Requires Node.js 20 or newer. The package is ESM; CommonJS projects can also `require()` it on Node.js 20.19+ or 22.12+. The Next.js peer range is 15 or newer; the repository's own development dependency is Next.js 16.

## Quick Start

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import { withStealthMark } from '@stealthmark/next';

export default withStealthMark(() => NextResponse.next(), {
  siteName: 'My SaaS',
  capabilities: [
    { id: 'search', endpoint: '/api/search', method: 'GET' },
    { id: 'create-order', endpoint: '/api/orders', method: 'POST', hitl: true },
  ],
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

`hitl` is advisory metadata for agents. StealthMark does not block, approve or rate-limit anything; enforce approvals in your own handler.

`withStealthMark` runs your own middleware (here, a plain `NextResponse.next()`), keeps its response and adds StealthMark on top. Your site now:
- Serves the manifest at `/.well-known/agent.json`, and also at `/.well-known/ai-plugin.json` and `/api/agent-manifest`. These paths are answered by the middleware for every visitor, so do not use them for your own routes.
- Detects agents that identify themselves by Accept header, User-Agent, or `x-stealthmark-agent`
- Adds an informational `x-stealthmark-shield: ACTIVE` marker header to responses from your middleware (it does not protect anything), plus `x-stealthmark-agent-detected` and `x-stealthmark-agent-id` when an agent is detected
- Answers `403` on `/.env*` and `/.git/*` before your middleware runs (see [Dotfiles](#dotfiles-env-and-git))
- Returns CORS-friendly agent manifests. The manifest on the three fixed paths is cacheable (`public, max-age=60, s-maxage=300`); a manifest or 403 chosen from the request headers on any other path is sent with `Cache-Control: private, no-store` and `Vary: accept, user-agent, x-stealthmark-agent`

## Composing with Existing Middleware

Already have auth, i18n or redirects in `middleware.ts`? Pass that function instead of `() => NextResponse.next()`:

```typescript
// middleware.ts
import { withStealthMark } from '@stealthmark/next';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function myMiddleware(request: NextRequest) {
  // Your existing auth, i18n, etc.
  return NextResponse.next();
}

export default withStealthMark(myMiddleware, {
  siteName: 'My SaaS',
  capabilities: [
    { id: 'search', endpoint: '/api/search', method: 'GET' },
  ],
});
```

If your middleware returns nothing, Next.js continues the chain untouched and no headers are added to that response.

## Minimal Option: Manifest Only

`stealthmark()` is the smallest setup. It serves the manifest paths, answers `Accept: application/agent+json` requests and applies `agentPolicy`, and returns nothing for every other request so Next.js serves your page as usual. Because it returns nothing there, it cannot add the marker or detection headers to your pages. Use `withStealthMark` if you want those. The middleware it returns is async, which Next.js accepts; if you call it yourself, `await` it.

```typescript
// middleware.ts
import { stealthmark } from '@stealthmark/next';

export default stealthmark({
  siteName: 'My SaaS',
  capabilities: [{ id: 'search', endpoint: '/api/search', method: 'GET' }],
});
```

## Dotfiles: `/.env*` and `/.git/*`

Both middlewares answer `/.env*` and `/.git/*` themselves, before your middleware and before agent detection, so a `.env` file or `.git` folder left in a deployment is never served. The default, `dotfiles: 'block'`, answers `403` with `Cache-Control: no-store`.

`dotfiles: 'synthetic_fixture'` is opt-in. Those paths then answer `200` with a short plain-text file: a first line saying the domain uses `@stealthmark/next`, synthetic values (`NODE_ENV`, `APP_URL`) and a `HEALTHCHECK_URL` pointing to `https://stealthmark.io/api/telemetry/canary?t=<token>`. The token is signed with your organization's Canary key and names the host, path and time it was served. When a scanner or agent later requests that URL, your StealthMark console records an `agent_blocked` event with reason `canary_triggered` (no units consumed); the URL always answers `401` and returns nothing. Serving the fixture makes no network call, and it holds no value from your environment.

```typescript
export default withStealthMark(() => NextResponse.next(), {
  siteName: 'My SaaS',
  dotfiles: 'synthetic_fixture',
  canaryKey: process.env.STEALTHMARK_CANARY_KEY, // from your StealthMark console
});
```

Without a valid Canary key (`canaryKey` or the `STEALTHMARK_CANARY_KEY` environment variable) the fixture is never served: the middleware warns once and answers `403`. Trade-off: a `200` on `/.env` can look like an exposed file to scanners that do not read its first line; the StealthMark scan reports it as info.

## Usage metering with StealthMark Cloud (optional)

Set an API key to report requests from self-identified agents as usage events to the [StealthMark](https://stealthmark.io) hosted API. Without a key the SDK makes no network calls.

```typescript
export default withStealthMark(() => NextResponse.next(), {
  siteName: 'My SaaS',
  apiKey: process.env.STEALTHMARK_API_KEY, // from your StealthMark console
  siteId: process.env.STEALTHMARK_SITE_ID, // optional, stored as site_id (UUID of a registered site)
  capabilities: [/* ... */],
  onQuotaExceeded: ({ pausedUntil }) => {
    console.warn(`StealthMark reporting paused until ${new Date(pausedUntil).toISOString()}`);
  },
});
```

What is sent, and where, is listed under "Data sent to StealthMark Cloud" in the `@stealthmark/core` README (`node_modules/@stealthmark/core/README.md`). The default host is https://api.stealthmark.io; override it with `usageEndpoint` or `STEALTHMARK_USAGE_ENDPOINT`. Identification is self-declared, and events are reported best-effort and can be dropped.

### Several sites, one API key

Every metered event carries `metadata.host`, the host the agent requested (the `Host` header, lowercased, no port). The console groups and filters agent traffic by `metadata.host`, so no configuration is needed to tell your sites apart.

`siteId` (or the `STEALTHMARK_SITE_ID` environment variable) is optional. It is only stored on the event as `site_id`, and it must be the UUID of a site registered to the same organization; otherwise it is stored as null.

Behind a proxy you control that rewrites the host, set `trustForwardedHost: true` to read the first `X-Forwarded-Host` value instead of `Host`. It is off by default because that header is client controlled; on most hosting platforms `Host` is already the public host.

## Route discovery

`discoverCapabilities()` (re-exported from `@stealthmark/core`) lists App Router `route.ts` handlers under `app/api` as capabilities. It needs Node (`fs`): do not call it from Edge or browser code, for example inside `middleware.ts`.

## License

Apache 2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
