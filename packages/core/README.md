# @stealthmark/core

**Framework-agnostic engine for detecting self-identified AI agents, serving an agent manifest and metering agent traffic.**

> Detects only agents that identify themselves. It does not detect stealth bots and is not a security control.

Detect AI agents that identify themselves, serve a structured agent manifest, and meter that traffic. Plain TypeScript, no runtime dependencies. It does not detect agents that disguise themselves, and it is not a security control.

The manifest is StealthMark's own format. It is not an A2A Agent Card, an MCP server manifest or an adopted standard.

## Installation

```bash
npm install @stealthmark/core
```

Requires Node.js 20 or newer. The package is ESM; CommonJS projects can also `require()` it on Node.js 20.19+ or 22.12+.

## Quick Start

```typescript
import { createStealthMark } from '@stealthmark/core';

const sm = createStealthMark({
  siteName: 'My SaaS',
  capabilities: [
    { id: 'search', endpoint: '/api/search', method: 'GET', description: 'Search products' },
    { id: 'create-order', endpoint: '/api/orders', method: 'POST', hitl: true },
  ],
});

// In your request handler:
const result = sm.detect(request.headers);

if (result.isAgent) {
  return new Response(sm.manifestJson, {
    headers: { 'content-type': 'application/agent+json' },
  });
}
```

`hitl` is advisory metadata for agents. StealthMark does not block, approve or rate-limit anything; enforce approvals in your own handler. The same goes for `pricing`: it is published in the manifest and never enforced.

## Agent Detection

StealthMark detects agents that identify themselves, via three signals (priority order):

1. **Accept header**: `application/agent+json`
2. **StealthMark header**: `x-stealthmark-agent`
3. **User-Agent patterns**: GPTBot, ClaudeBot, PerplexityBot, etc.

```typescript
import { detectAgent } from '@stealthmark/core';

const result = detectAgent(request.headers);
// { isAgent: true, agentId: 'GPTBot', method: 'user-agent' }
```

All three signals are self-declared. Any client can send them, and agents that look like browsers are not detected.

## Usage Metering

Usage is counted per **agent event**: one HTTP request that identifies itself as an AI agent (via `Accept: application/agent+json`, the `x-stealthmark-agent` header, or a known agent token in the `User-Agent`). Identification is self-declared, so a human or script can send these signals and be counted, and agents that look like browsers are not counted. Events are reported best-effort and can be dropped (see below). They are batched and sent to `POST /v1/usage/ingest` with your site API key.

```typescript
const sm = createStealthMark({
  siteName: 'My App',
  apiKey: process.env.STEALTHMARK_API_KEY,
  // usageEndpoint: 'https://...',          // or STEALTHMARK_USAGE_ENDPOINT
  // reportUsage: false,                    // opt out (defaults to true when a key is set)
  siteId: process.env.STEALTHMARK_SITE_ID,  // optional, stored as site_id (UUID of a registered site)
  onQuotaExceeded: ({ pausedUntil, retryAfterSeconds, dropped }) => {
    // Optional: surface the pause (log, alert, status page). Never throws into the SDK.
    logger.warn(`StealthMark quota reached, reporting paused until ${new Date(pausedUntil).toISOString()}`);
  },
});

sm.recordAgentEvent({
  event_type: 'agent_request', // 'agent_request' | 'agent_blocked' | 'agent_manifest'
  agent_identifier: 'GPTBot',
  metadata: { path: '/pricing', method: 'GET' },
});

sm.usage.stats(); // { queued, sent, dropped, failures, pausedUntil, quotaExceededUntil }
await sm.usage.flush(); // e.g. before a serverless function or process exits
```

The `@stealthmark/next` and `@stealthmark/express` adapters call `recordAgentEvent` exactly once per agent request for you.

**Site attribution.** The adapters add `metadata.host` to every metered event (the `Host` header, lowercased, no port). The console groups and filters by `metadata.host`, automatically and with no config. Set `trustForwardedHost: true` to read the first `X-Forwarded-Host` value instead; enable it only behind a proxy you control.

`siteId` (or the `STEALTHMARK_SITE_ID` env var) is optional and only stored on the event as `site_id`. It must be the UUID of a site registered to the same organization, otherwise it is stored as null; a value that is not a UUID is ignored with one warning. `normalizeHost`, `resolveRequestHost` and `buildEventMetadata` are exported if you meter events yourself.

Behavior:

- Never throws, never blocks the request path, no dependencies (global `fetch`); timers are unref'd so the reporter never keeps a process alive.
- Batches by `maxBatch` (default 100, max 500) or `flushIntervalMs` (default 1000).
- Retries 5xx and network errors three times (250 ms, 1 s, 4 s), then drops the batch (`failures`, `dropped`).
- On `429 quota_exceeded` it stops sending for `retry_after_seconds` (default 300) and drops events meanwhile (`stats().dropped`), exposing the resume time as `stats().pausedUntil` (`null` when not paused; `quotaExceededUntil` is the same value kept for compatibility). Pass `onQuotaExceeded` to be told when it happens: it receives `{ pausedUntil, retryAfterSeconds, dropped }` once per 429, and exceptions it throws are swallowed. Events are not buffered across the pause, so a customer who wants to alert on it should wire this callback. Your site keeps serving traffic; only reporting pauses.
- Any other `429` is the API's per-key rate limiter (`rate_limit_exceeded`), not a quota problem: nothing is dropped, `pausedUntil` stays `null` and `onQuotaExceeded` is not called. The batch stays queued and sending resumes after the `Retry-After` header (or `retry_after` in the body; 60 seconds when neither is present, never more than 300). Events recorded during the wait are queued, up to 10,000, and `flush()` returns without sending until the wait is over.
- The API key is trimmed. A key that still contains spaces, control or non-ASCII characters (for example an arrow key typed while pasting it into a terminal) cannot be sent in an HTTP header, so reporting stays off. That case, a key the API rejects (`401`/`403`) and an API it cannot reach each print one warning through the `logger` option of `createStealthMark` and every adapter (default `console`, `false` silences it). Warnings never include the key.
- On serverless or Edge runtimes, pending timers can be frozen after the response is sent. Call `await sm.usage.flush()` (or `event.waitUntil(sm.usage.flush())`) at the end of the request when you need delivery guarantees.

You can also use the reporter standalone:

```typescript
import { createUsageReporter } from '@stealthmark/core';

const usage = createUsageReporter({ apiKey: process.env.STEALTHMARK_API_KEY ?? '', maxBatch: 50 });
usage.record({ event_type: 'agent_request' });
```

## Data sent to StealthMark Cloud

Only when an API key is configured (`apiKey` option or `STEALTHMARK_API_KEY`). Without a key the SDK makes no network calls. Requests not identified as agents are never reported.

- Usage events (`POST /v1/usage/ingest`, sent with `Authorization: Bearer $STEALTHMARK_API_KEY`): event type, agent identifier, request path, method, host and timestamp. When no better identifier exists, the agent identifier is the request's `User-Agent`. Set `reportUsage: false` to turn this off.

The default host is https://api.stealthmark.io, the StealthMark hosted API. Override it with `usageEndpoint` or `STEALTHMARK_USAGE_ENDPOINT`.

## Route discovery

`discoverCapabilities()` lists Next.js App Router `route.ts` handlers under `app/api` or `src/app/api` as capabilities. It does not scan Express, Fastify or Pages Router routes; declare those in `capabilities`. It never sets `pricing`, and sets `hitl` only for paths matching the `hitlKeywords` you pass.

`discoverCapabilities()` needs Node (`fs`). Do not call it from Edge or browser code.

## License

Apache 2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
