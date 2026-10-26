// ═══════════════════════════════════════════════════════════════════
// @stealthmark/next — Public API
// ═══════════════════════════════════════════════════════════════════

export { stealthmark, withStealthMark, defaultMatcher } from './middleware.js';
export type { NextLikeRequest, StealthMarkNextConfig } from './middleware.js';
export type { DotfilePolicy } from './canary.js';
export { discoverCapabilities } from '@stealthmark/core';

// Re-export core types for convenience
export type {
  StealthMarkConfig,
  Capability,
  HttpMethod,
  AgentManifest,
  DetectionResult,
  RouteDiscoveryOptions,
} from '@stealthmark/core';
