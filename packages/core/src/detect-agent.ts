// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Agent Detection Engine
// Detects requests that identify themselves as AI agents
// ═══════════════════════════════════════════════════════════════════

import type { DetectionResult } from './types.js';

/**
 * User-Agent substrings published by AI vendors for their crawlers and user-triggered fetchers.
 * Matching is a case-insensitive substring test, so versions and suffixes are ignored.
 */
const VENDOR_AGENT_PATTERNS: string[] = [
  // OpenAI
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',

  // Anthropic
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'Anthropic-AI',

  // Perplexity
  'PerplexityBot',
  'Perplexity-User',

  // Meta, Amazon, Google, Common Crawl, ByteDance, Cohere, DuckDuckGo, You.com
  'Meta-ExternalAgent',
  'Amazonbot',
  'Google-CloudVertexBot',
  'CCBot',
  'Bytespider',
  'cohere-ai',
  'DuckAssistBot',
  'YouBot',
];

/**
 * Identifiers that agent clients and protocol libraries declare about themselves.
 * They are not tied to a crawler vendor, so they are only as trustworthy as the caller:
 * any HTTP client can send them. Treat a match as a self-declaration, not as proof.
 */
const DECLARED_AGENT_IDENTIFIERS: string[] = [
  'OpenAI-Operator',
  'Claude-Agent',
  'MCP-Client',
  'A2A-Client',
  'AgentProtocol',
];

const DEFAULT_AGENT_PATTERNS: string[] = [...VENDOR_AGENT_PATTERNS, ...DECLARED_AGENT_IDENTIFIERS];

/**
 * Detects whether an incoming HTTP request originates from an autonomous AI agent.
 *
 * Detection is performed via three explicit signals (checked in priority order):
 * 1. **Accept header**: `application/agent+json`
 * 2. **StealthMark header**: `x-stealthmark-agent` presence
 * 3. **User-Agent pattern matching**: vendor crawler tokens plus self-declared agent identifiers.
 *    Google-Extended is deliberately absent: it is a robots.txt token, never sent as a User-Agent.
 *
 * Plain `application/json` requests are never classified as agents, so a site's own API calls are not metered.
 *
 * @param headers - Standard Headers object or plain Record
 * @param extraPatterns - Additional User-Agent substrings to detect
 * @returns DetectionResult with isAgent flag and detection metadata
 */
export function detectAgent(
  headers: Headers | Record<string, string | undefined>,
  extraPatterns: string[] = []
): DetectionResult {
  const get = (name: string): string => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? '';
    }
    return headers[name] ?? headers[name.toLowerCase()] ?? '';
  };

  const accept = get('accept');
  const userAgent = get('user-agent');
  const agentHeader = get('x-stealthmark-agent');

  // Method 1: Accept header signals agent protocol
  if (accept.includes('application/agent+json')) {
    return {
      isAgent: true,
      agentId: agentHeader || undefined,
      method: 'accept-header',
    };
  }

  // Method 2: Explicit StealthMark agent header
  if (agentHeader) {
    return {
      isAgent: true,
      agentId: agentHeader,
      method: 'stealthmark-header',
    };
  }

  // A JSON-only Accept header is NOT treated as an agent signal: the site's own frontend
  // fetch/XHR calls look exactly like that, and metering them would bill human traffic.

  // Method 3: User-Agent pattern matching
  const allPatterns = [...DEFAULT_AGENT_PATTERNS, ...extraPatterns];
  const ua = userAgent.toLowerCase();

  for (const pattern of allPatterns) {
    if (ua.includes(pattern.toLowerCase())) {
      return {
        isAgent: true,
        agentId: pattern,
        method: 'user-agent',
      };
    }
  }

  // Not an agent
  return {
    isAgent: false,
    method: 'none',
  };
}
