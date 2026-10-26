// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Public API
// Agent detection, agent manifest generation and usage metering
// ═══════════════════════════════════════════════════════════════════

export { createStealthMark } from './create.js';
export { detectAgent } from './detect-agent.js';
export { generateManifest, serializeManifest } from './manifest.js';
export { createUsageReporter, resolveAgentIdentifier } from './usage-reporter.js';
export type { UsageReporter } from './usage-reporter.js';
export { discoverCapabilities } from './auto-discovery.js';
export { normalizeHost, resolveRequestHost, buildEventMetadata, MAX_HOST_LENGTH } from './request-context.js';

export type { RouteDiscoveryOptions } from './auto-discovery.js';

export type {
  StealthMarkConfig,
  AgentManifest,
  Capability,
  DetectionResult,
  HttpMethod,
  UsageEvent,
  UsageEventType,
  UsageReporterOptions,
  UsageStats,
  QuotaExceededInfo,
  UsageLogger,
  AgentPolicy,
} from './types.js';

export type { StealthMarkInstance, StealthMarkInstance as StealthMark } from './create.js';
