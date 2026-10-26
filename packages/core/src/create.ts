// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Factory & Orchestrator
// Creates a configured StealthMark instance that handles requests
// ═══════════════════════════════════════════════════════════════════

import type {
  StealthMarkConfig,
  AgentManifest,
  DetectionResult,
  UsageEvent,
  AgentPolicy,
} from './types.js';
import { detectAgent } from './detect-agent.js';
import { generateManifest, serializeManifest } from './manifest.js';
import { createUsageReporter, type UsageReporter } from './usage-reporter.js';

/** The StealthMark runtime instance returned by createStealthMark() */
export interface StealthMarkInstance {
  /** The generated agent manifest */
  readonly manifest: AgentManifest;
  /** Serialized manifest JSON string */
  readonly manifestJson: string;
  /** Detect whether a request is from an agent */
  detect: (headers: Headers | Record<string, string | undefined>) => DetectionResult;
  /** Standard response headers to add */
  readonly responseHeaders: Record<string, string>;
  /** Best-effort usage reporter (inert when no API key is configured) */
  readonly usage: UsageReporter;
  /** Effective handling of agent requests on ordinary paths */
  readonly agentPolicy: AgentPolicy;
  /** Registered site id attached to every metered event (config `siteId`, else STEALTHMARK_SITE_ID); undefined when not set or not a UUID */
  readonly siteId: string | undefined;
  /** Whether the adapters read the request host from X-Forwarded-Host instead of Host (config `trustForwardedHost`, default false) */
  readonly trustForwardedHost: boolean;
  /** Meter one agent event. Call exactly once per request identified as an AI agent. */
  recordAgentEvent: (event: UsageEvent) => void;
}

type EnvName = 'STEALTHMARK_API_KEY' | 'STEALTHMARK_USAGE_ENDPOINT' | 'STEALTHMARK_SITE_ID';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readEnv(name: EnvName): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  switch (name) {
    case 'STEALTHMARK_API_KEY':
      return process.env.STEALTHMARK_API_KEY || undefined;
    case 'STEALTHMARK_USAGE_ENDPOINT':
      return process.env.STEALTHMARK_USAGE_ENDPOINT || undefined;
    case 'STEALTHMARK_SITE_ID':
      return process.env.STEALTHMARK_SITE_ID || undefined;
  }
}

/**
 * The ingest API rejects the whole batch when one event carries a site_id that is not a UUID, so a
 * malformed id is dropped (with one warning) instead of costing the site its metered events.
 */
function resolveSiteId(configured: string | undefined): string | undefined {
  const raw = configured?.trim() || readEnv('STEALTHMARK_SITE_ID')?.trim();
  if (!raw) return undefined;
  if (UUID_PATTERN.test(raw)) return raw.toLowerCase();
  if (typeof console !== 'undefined') {
    console.warn('[stealthmark] siteId ignored: expected the UUID of a site registered in the StealthMark console.');
  }
  return undefined;
}

/**
 * Creates a configured StealthMark instance.
 *
 * This is the main entry point for the SDK. It initializes agent detection,
 * manifest generation and usage metering.
 *
 * @example
 * ```typescript
 * import { createStealthMark } from '@stealthmark/core';
 *
 * const sm = createStealthMark({
 *   siteName: 'My SaaS',
 *   capabilities: [
 *     { id: 'search', endpoint: '/api/search', method: 'GET' },
 *   ],
 * });
 *
 * // In your request handler:
 * const result = sm.detect(request.headers);
 * if (result.isAgent) {
 *   return new Response(sm.manifestJson, {
 *     headers: { 'content-type': 'application/agent+json' },
 *   });
 * }
 * ```
 */
export function createStealthMark(config: StealthMarkConfig): StealthMarkInstance {
  const manifest = generateManifest(config);
  const manifestJson = serializeManifest(manifest);
  const usageApiKey = config.apiKey ?? readEnv('STEALTHMARK_API_KEY');
  const siteId = resolveSiteId(config.siteId);
  const trustForwardedHost = config.trustForwardedHost === true;
  const usage = createUsageReporter({
    apiKey: config.reportUsage === false ? '' : (usageApiKey ?? ''),
    endpoint: config.usageEndpoint ?? readEnv('STEALTHMARK_USAGE_ENDPOINT'),
    onQuotaExceeded: config.onQuotaExceeded,
    logger: config.logger,
  });

  const responseHeaders: Record<string, string> = {
    'x-stealthmark-shield': 'ACTIVE',
    'x-stealthmark-agent-policy': config.agentPolicy ?? 'observe',
    ...(config.headers ?? {}),
  };

  return {
    manifest,
    manifestJson,
    agentPolicy: config.agentPolicy ?? 'observe',
    siteId,
    trustForwardedHost,

    detect(headers: Headers | Record<string, string | undefined>): DetectionResult {
      return detectAgent(headers, config.agentPatterns);
    },

    responseHeaders,

    usage,

    recordAgentEvent(event: UsageEvent): void {
      usage.record(siteId && !event.site_id ? { ...event, site_id: siteId } : event);
    },
  };
}
