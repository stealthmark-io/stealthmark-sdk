// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Type Definitions
// Configuration, manifest, detection and usage-metering types
// ═══════════════════════════════════════════════════════════════════

/** HTTP methods supported by capabilities */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A single capability exposed to AI agents */
export interface Capability {
  /** Unique identifier (e.g. 'search-products', 'create-order') */
  id: string;
  /** Human-readable description for agents */
  description?: string;
  /** HTTP method */
  method: HttpMethod;
  /** Endpoint path (e.g. '/api/search') or full URL */
  endpoint: string;
  /** Input schema hint for agents (key-value description) */
  inputSchema?: Record<string, string>;
  /** Advisory flag published in the manifest: tells agents this action should have human approval. The SDK does not enforce it. */
  hitl?: boolean;
  /** Pricing info published in the manifest (e.g. 'Free', '$0.01/call'). Informational only. */
  pricing?: string;
}

/**
 * How agent-identified requests on ordinary paths are handled.
 * 'observe' (default): the site answers normally, the request is metered and tagged with x-stealthmark-agent-detected.
 * 'manifest': the agent receives the agent manifest instead of the page (Next.js: on every path; Express and Fastify: on `/` only).
 * 'block': the agent receives 403 and the event is metered as agent_blocked.
 * Manifest paths and requests with `Accept: application/agent+json` always receive the manifest.
 */
export type AgentPolicy = 'observe' | 'manifest' | 'block';

/** Configuration for the StealthMark SDK */
export interface StealthMarkConfig {
  /** Your site's display name */
  siteName: string;
  /** Site origin URL (e.g. 'https://myapp.com'). Omitted from the manifest when not set. */
  origin?: string;
  /** Version string for your agent manifest */
  version?: string;
  /** Capabilities your site exposes to AI agents */
  capabilities?: Capability[];
  /** Contact email for agent operators */
  contactEmail?: string;
  /**
   * StealthMark API key (Bearer sk_live_...). Enables best-effort usage reporting unless `reportUsage` is false.
   * Falls back to process.env.STEALTHMARK_API_KEY.
   */
  apiKey?: string;
  /**
   * Registered site id from the StealthMark console; attaches site_id to every metered event.
   * Env: STEALTHMARK_SITE_ID
   */
  siteId?: string;
  /**
   * Use X-Forwarded-Host (first value) instead of Host for metadata.host. Enable only behind a proxy you control;
   * on most hosting platforms the Host header is already the public host. Default: false.
   */
  trustForwardedHost?: boolean;
  /** Override the usage ingest endpoint (default: StealthMark API). Env: STEALTHMARK_USAGE_ENDPOINT */
  usageEndpoint?: string;
  /** Report metered agent events to /v1/usage/ingest. Defaults to true when an API key is available. */
  reportUsage?: boolean;
  /** Called when the usage API answers 429 quota_exceeded and reporting pauses. See `UsageReporterOptions`. */
  onQuotaExceeded?: (info: QuotaExceededInfo) => void;
  /** Where usage reporting warnings go (default `console`; `false` silences them). See `UsageReporterOptions`. */
  logger?: UsageLogger | false;
  /** Custom agent detection patterns (User-Agent substrings) */
  agentPatterns?: string[];
  /** Handling of agent requests on ordinary paths (default 'observe') */
  agentPolicy?: AgentPolicy;
  /** Custom response headers to add to all responses */
  headers?: Record<string, string>;
}

/** The generated agent manifest (served at /.well-known/agent.json) */
export interface AgentManifest {
  name: string;
  version: string;
  origin?: string;
  protocol: string;
  capabilities: Capability[];
  agent_policy: {
    mode: AgentPolicy;
    identification: { headers: string[] };
    conduct: string[];
  };
  contact?: string;
  meta?: Record<string, unknown>;
}

/** Result of agent detection */
export interface DetectionResult {
  /** Whether the request is from an AI agent */
  isAgent: boolean;
  /** Detected agent identifier (if any) */
  agentId?: string;
  /** Detection method used */
  method: 'accept-header' | 'stealthmark-header' | 'user-agent' | 'none';
}

/** Metered event types accepted by POST /v1/usage/ingest */
export type UsageEventType = 'agent_request' | 'agent_blocked' | 'agent_manifest';

/** A single metered agent event (one HTTP request identified as coming from an AI agent) */
export interface UsageEvent {
  /** Defaults to 'agent_request' on the server */
  event_type?: UsageEventType;
  /** Integer >= 1, normally 1 */
  units?: number;
  site_id?: string;
  agent_identifier?: string;
  /** ISO timestamp. Stamped at record() time when omitted. */
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

/** Options for createUsageReporter */
export interface UsageReporterOptions {
  /** Site API key sent as `Authorization: Bearer <apiKey>` */
  apiKey: string;
  /** API base URL (default: https://api.stealthmark.io, the StealthMark hosted API) */
  endpoint?: string;
  /** Max time an event waits in the queue before a flush (default: 1000) */
  flushIntervalMs?: number;
  /** Events per request, 1..500 (default: 100) */
  maxBatch?: number;
  /**
   * Called each time the ingest API answers 429 quota_exceeded, so the host app can surface it
   * (log, alert, status page). Reporting then pauses until `info.pausedUntil` and events recorded
   * in the meantime are dropped and counted in `stats().dropped`. Your site keeps serving traffic.
   * Errors thrown by the callback are swallowed.
   */
  onQuotaExceeded?: (info: QuotaExceededInfo) => void;
  /**
   * Receives one warning per problem kind (an API key that cannot be sent in a header, a key the API
   * rejects, an unreachable API), so a misconfigured site does not fail silently. Warnings never
   * contain the key. Default: `console`. Pass `false` to silence them.
   */
  logger?: UsageLogger | false;
}

/** Minimal logger for usage reporter warnings */
export interface UsageLogger {
  warn: (message: string) => void;
}

/** Details passed to `onQuotaExceeded` */
export interface QuotaExceededInfo {
  /** Epoch ms until which reporting is paused */
  pausedUntil: number;
  /** Seconds the server asked the reporter to wait (default 300 when the 429 carries no hint) */
  retryAfterSeconds: number;
  /** Events discarded because of this 429 (rejected part of the batch plus everything queued) */
  dropped: number;
}

/** Reporter counters */
export interface UsageStats {
  /** Events waiting to be sent */
  queued: number;
  /** Events accepted by the ingest API */
  sent: number;
  /** Events discarded (quota pause, rejected, queue full, retries exhausted) */
  dropped: number;
  /** Batches that failed after all retries or were refused with a non-retryable 4xx */
  failures: number;
  /** Epoch ms until which reporting is paused after a 429, or null when not paused */
  pausedUntil: number | null;
  /** Same value as `pausedUntil` (kept for backward compatibility) */
  quotaExceededUntil: number | null;
}
