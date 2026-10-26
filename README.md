# StealthMark SDK

[![CI](https://github.com/stealthmark-io/stealthmark-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/stealthmark-io/stealthmark-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@stealthmark/core.svg?label=npm)](https://www.npmjs.com/package/@stealthmark/core)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./packages/core/tsconfig.json)
[![DEUSPROOF certificate of birth](https://deusproof.com/api/agents/stealthmark/badge.svg)](https://deusproof.com/birth/stealthmark)

Open-source (Apache-2.0) SDK that lets a website tell which requests come from AI agents that identify themselves, serve them a structured agent manifest or leave the page untouched, and meter that traffic.
It ships as framework-agnostic core logic plus adapters for Next.js, Express and Fastify, and a CLI that scaffolds a starter middleware file and checks a site for a StealthMark agent manifest.
The hosted dashboard and billing at [stealthmark.io](https://stealthmark.io) are optional and are not part of this repository.

> Detects only agents that identify themselves. It does not detect stealth bots and is not a security control.

## How a request is handled

```text
incoming request
 |
 +- /.well-known/agent.json, /.well-known/ai-plugin.json or /api/agent-manifest
 |    -> 200 agent manifest, for any caller
 |
 +- no agent signal (browsers and every client that does not identify itself)
 |    -> your app answers normally, plus the x-stealthmark-shield and
 |       x-stealthmark-agent-policy headers; not metered
 |
 +- agent signal: Accept: application/agent+json, x-stealthmark-agent header
    or a known AI User-Agent. Always metered, then by agentPolicy:
      +- Accept: application/agent+json   -> 200 agent manifest (any policy)
      +- observe (default)                -> your app answers normally, tagged
      |                                      x-stealthmark-agent-detected
      +- manifest                         -> 200 agent manifest (Next.js: every path;
      |                                      Express/Fastify: "/" only, other paths
      |                                      answer normally like observe)
      +- block                            -> 403 JSON {"error":"agent_blocked"}
```

- "Metered" means the event is queued. It leaves your server only when an API key is configured, in batches in the background, and can be dropped. The 403 is metered as `agent_blocked` and manifest hits as `agent_manifest`.
- The manifest at the three fixed paths is the same for every caller and is cacheable (`public, max-age=60, s-maxage=300` on Next.js). A manifest or 403 chosen from the request headers on any other path (`Accept: application/agent+json`, `agentPolicy` `manifest` or `block`) is sent with `Cache-Control: private, no-store` and `Vary: Accept, User-Agent, x-stealthmark-agent`, so a shared cache cannot hand it to other visitors.
- Detection runs on every request and inspects the request headers and path. That is cheap but not free: the SDK adds a small per-request cost on all traffic, and no latency figure is published here.
- Next.js: `withStealthMark` adds the headers to the response of your own middleware. The minimal `stealthmark()` returns nothing for requests it passes through, so it adds no headers to them.

## Packages

| Package | Path | What it is |
| :--- | :--- | :--- |
| `@stealthmark/core` | [`packages/core`](./packages/core) | Framework-agnostic engine: agent detection, manifest generation, usage metering |
| `@stealthmark/next` | [`packages/next`](./packages/next) | Next.js middleware (`withStealthMark`, `stealthmark`) |
| `@stealthmark/express` | [`packages/express`](./packages/express) | Express and Fastify middleware |
| `@stealthmark/cli` | [`packages/cli`](./packages/cli) | `stealthmark init` writes a starter middleware file, `stealthmark verify https://your-site.example` checks a live site, and `stealthmark audit <domain>` runs a 33-point passive AI-surface, Shodan InternetDB Port/CVE recon, Railway/PaaS Secret Shield, DNS/DMARC, bundle leak, PHP/CMS RCE & Edge WAF readiness check |

Requires Node.js 20 or newer.

## Status

The packages are published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements): [`@stealthmark/core`](https://www.npmjs.com/package/@stealthmark/core), [`@stealthmark/next`](https://www.npmjs.com/package/@stealthmark/next), [`@stealthmark/express`](https://www.npmjs.com/package/@stealthmark/express) and [`@stealthmark/cli`](https://www.npmjs.com/package/@stealthmark/cli). To be notified of new versions, watch this repository and choose **Custom → Releases**.

```bash
npm install @stealthmark/next @stealthmark/core      # Next.js
npm install @stealthmark/express @stealthmark/core   # Express or Fastify
npx @stealthmark/cli init
```

To build from source instead:

```bash
git clone https://github.com/stealthmark-io/stealthmark-sdk.git
cd stealthmark-sdk
npm install
npm run build
```

Development commands, all run from the repository root:

```bash
npm run build      # builds core first, then next, express and cli
npm run typecheck
npm test
```

## Next.js quick start

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import { withStealthMark } from '@stealthmark/next';

export default withStealthMark(() => NextResponse.next(), {
  siteName: 'My SaaS',
  agentPolicy: 'observe', // default: your pages answer normally, agent requests are tagged and metered
  apiKey: process.env.STEALTHMARK_API_KEY, // optional: without a key nothing is sent anywhere
  capabilities: [
    { id: 'search', endpoint: '/api/search', method: 'GET' },
  ],
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
```

In `observe` mode your page content is not changed. What differs is response headers: `withStealthMark`, Express and Fastify add the informational `x-stealthmark-shield` and `x-stealthmark-agent-policy` headers to every response they handle, human visitors included. Requests identified as coming from an agent also get an `x-stealthmark-agent-detected` response header and, if an API key is set, are reported as usage events. `/.well-known/agent.json` and requests with `Accept: application/agent+json` always receive the manifest. Other policies are `manifest` (Next.js: detected agents get the manifest on every path; Express and Fastify: only on `/`) and `block` (agents get a 403).

The manifest is StealthMark's own format. It is not an A2A Agent Card, an MCP server manifest or an adopted standard.

## Express and Fastify quick start

```typescript
import express from 'express';
import { stealthmark } from '@stealthmark/express';

const app = express();
app.use(stealthmark({
  siteName: 'My Express API',
  agentPolicy: 'observe', // reads STEALTHMARK_API_KEY from the environment when set
}));
app.listen(3000);
```

```typescript
import Fastify from 'fastify';
import { stealthmarkFastify } from '@stealthmark/express';

const fastify = Fastify();
fastify.addHook('preHandler', stealthmarkFastify({ siteName: 'My Fastify Service' }));
fastify.listen({ port: 3000 });
```

Under `manifest` policy, Express and Fastify answer the manifest only on `/`, while Next.js answers it on every path.

## CLI

Both commands are non-interactive: there are no prompts. Run them with `npx @stealthmark/cli`, or install the CLI globally with `npm install -g @stealthmark/cli` and use `stealthmark`.

`stealthmark init --name "My Site" --force` (both flags optional) writes one starter file in the current directory and prints the remaining steps. It does not install packages or touch any other file.

- Framework: Next.js, Express or Fastify, read from the `dependencies` and `devDependencies` of `package.json` (first match in that order), or from a `next.config.*` file. Nothing detected: nothing is written and the exit code is 1.
- File: Next.js gets `middleware.ts` (`src/middleware.ts` if a `src/` directory exists) using the minimal `stealthmark()` middleware; Express and Fastify get `stealthmark.middleware.ts`.
- `capabilities`: for Next.js, the `app/api/**/route.ts` handlers it finds; for Express and Fastify an empty list that you fill in.
- `--name` sets `siteName` (default: the `name` in `package.json`, else `My App`). `--force` overwrites an existing file; without it, an existing file is left alone and the exit code is 1.

`stealthmark verify https://your-site.example` checks that a live site serves a StealthMark manifest on `/.well-known/agent.json`, answers `Accept: application/agent+json` on `/`, and sends the `x-stealthmark-shield` header. The URL is required. See [`packages/cli`](./packages/cli) for details.

## What it detects, and what it does not

It detects agents that **identify themselves**, through any of:

- `Accept: application/agent+json`
- the `x-stealthmark-agent` request header
- a known AI crawler or agent token in the `User-Agent` (for example GPTBot, ClaudeBot, PerplexityBot, Bytespider)

All of these are self-declared: a human or a script can send them and be counted.

It does **not** detect stealth bots. A scraper or agent that sends a browser User-Agent, rotates identities, runs a headless browser or hides behind residential proxies looks like a human to this SDK. Treat the numbers it produces as a count of self-identified agent traffic, not as a complete count of automated traffic. It is also not a security control: do not rely on it to keep anyone out, and note that `hitl` and `pricing` on a capability are advisory metadata published in the manifest that the SDK never enforces.

## Data sent to StealthMark Cloud

Only when an API key is configured (`apiKey` option or `STEALTHMARK_API_KEY`). Without a key the SDK makes no network calls. Requests not identified as agents are never reported.

- Usage events (`POST /v1/usage/ingest`, sent with `Authorization: Bearer $STEALTHMARK_API_KEY`): event type, agent identifier, request path, method, host and timestamp. When no better identifier exists, the agent identifier is the request's `User-Agent`. Set `reportUsage: false` to turn this off. Events are reported best-effort and can be dropped.

The default host is https://api.stealthmark.io, the StealthMark hosted API. Override it with `usageEndpoint` or `STEALTHMARK_USAGE_ENDPOINT`.

## Links

- Website: https://stealthmark.io
- Interactive 21-Point Auditor: https://stealthmark.io/scan
- Agent Skill Manifest (OpenClaw / x402): https://stealthmark.io/skill.md
- MCP Server Endpoint: https://stealthmark.io/api/mcp
- Documentation: https://stealthmark.io/docs
- Security reports: see [SECURITY.md](./SECURITY.md)
- Maintainers: release steps in [RELEASING.md](./RELEASING.md)

## License

Apache-2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
