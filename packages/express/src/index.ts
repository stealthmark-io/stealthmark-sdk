// ═══════════════════════════════════════════════════════════════════
// @stealthmark/express — Public API
// Express and Fastify middleware: agent detection, agent manifest and usage metering
// ═══════════════════════════════════════════════════════════════════

export { stealthmarkExpress, stealthmarkExpress as stealthmark } from './express.js';
export { stealthmarkFastify } from './fastify.js';

export { discoverCapabilities } from '@stealthmark/core';

// Re-export core types for developer convenience
export type {
  StealthMarkConfig,
  Capability,
  HttpMethod,
  AgentManifest,
  DetectionResult,
  RouteDiscoveryOptions,
} from '@stealthmark/core';
