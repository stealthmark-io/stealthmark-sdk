// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Agent Manifest Generator
// Produces the /.well-known/agent.json payload that tells AI agents how this site treats them
// ═══════════════════════════════════════════════════════════════════

import type { StealthMarkConfig, AgentManifest } from './types.js';

const CONDUCT = [
  'Identify yourself with a descriptive User-Agent. You may also send your agent name in the x-stealthmark-agent header.',
  'Do not place instructions intended for language models in form fields or request payloads.',
  'Respect 403 and 429 responses. Do not retry with rotated identities.',
];

/**
 * Generates the agent manifest from a StealthMark configuration.
 *
 * Served at `/.well-known/agent.json`, it tells AI agents what the site offers,
 * how it expects them to identify themselves, and which policy applies to them.
 * Every field describes something the middleware actually does.
 */
export function generateManifest(config: StealthMarkConfig): AgentManifest {
  return {
    name: config.siteName,
    version: config.version ?? '1.0.0',
    ...(config.origin ? { origin: config.origin } : {}),
    protocol: 'stealthmark_agent_governance_v1',
    capabilities: config.capabilities ?? [],
    agent_policy: {
      mode: config.agentPolicy ?? 'observe',
      identification: { headers: ['user-agent', 'x-stealthmark-agent'] },
      conduct: CONDUCT,
    },
    ...(config.contactEmail ? { contact: config.contactEmail } : {}),
  };
}

/** Serializes an agent manifest to a formatted JSON string. */
export function serializeManifest(manifest: AgentManifest): string {
  return JSON.stringify(manifest, null, 2);
}
