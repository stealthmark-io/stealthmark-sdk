// ═══════════════════════════════════════════════════════════════════
// @stealthmark/express — Express Middleware Handler
// Detects self-identified AI agents, serves the agent manifest and meters agent traffic for Express apps
// ═══════════════════════════════════════════════════════════════════

import { createStealthMark, type StealthMarkConfig } from '@stealthmark/core';
import { NEGOTIATED_CACHE_CONTROL, isManifestPath, meterAgentRequest, meterBlockedRequest, negotiatedVary } from './meter.js';

export interface ExpressRequestLike {
  method?: string;
  url?: string;
  path?: string;
  secure?: boolean;
  headers: Record<string, string | string[] | undefined>;
}

export interface ExpressResponseLike {
  setHeader(name: string, value: string): void;
  /** Present on real Express responses; used to keep a Vary header that earlier middleware already set. */
  getHeader?(name: string): unknown;
  status(code: number): ExpressResponseLike;
  send(body: string): void;
}

export type ExpressNextFunction = (err?: unknown) => void;

const BLOCKED_BODY = { error: 'agent_blocked', message: 'This site does not accept automated agent traffic.' };

function markNegotiated(res: ExpressResponseLike): void {
  res.setHeader('Vary', negotiatedVary(res.getHeader?.('Vary')));
  res.setHeader('Cache-Control', NEGOTIATED_CACHE_CONTROL);
}

/**
 * Creates an Express-compatible middleware that serves the agent manifest, applies `agentPolicy`
 * and meters requests from agents that identify themselves.
 */
export function stealthmarkExpress(config: StealthMarkConfig) {
  const sm = createStealthMark(config);

  return function stealthmarkMiddleware(
    req: ExpressRequestLike,
    res: ExpressResponseLike,
    next: ExpressNextFunction
  ): void {
    const rawPath = req.path || req.url || '/';
    const pathOnly = rawPath.split('?')[0];

    const headersRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headersRecord[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }
    }

    const agentDetection = sm.detect(headersRecord);
    const isWellKnown = isManifestPath(pathOnly);
    const isRoot = pathOnly === '/' || pathOnly === '';
    const acceptsAgentJson = (headersRecord['accept'] ?? '').includes('application/agent+json');
    const servesManifest =
      isWellKnown || (agentDetection.isAgent && (acceptsAgentJson || (isRoot && sm.agentPolicy === 'manifest')));
    const blocked = agentDetection.isAgent && !servesManifest && sm.agentPolicy === 'block';

    if (blocked) {
      meterBlockedRequest(sm, headersRecord, agentDetection, pathOnly, req.method);
      for (const [k, v] of Object.entries(sm.responseHeaders)) {
        res.setHeader(k, v);
      }
      markNegotiated(res);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(403).send(JSON.stringify(BLOCKED_BODY));
      return;
    }

    meterAgentRequest(sm, headersRecord, agentDetection, pathOnly, req.method);

    // 1. Intercept well-known paths or agent requests on root
    if (servesManifest) {
      res.setHeader('Content-Type', 'application/agent+json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-stealthmark-agent');
      if (!isWellKnown) markNegotiated(res);

      for (const [k, v] of Object.entries(sm.responseHeaders)) {
        res.setHeader(k, v);
      }

      if (agentDetection.isAgent) {
        res.setHeader('x-stealthmark-agent-detected', 'true');
        if (agentDetection.agentId) {
          res.setHeader('x-stealthmark-agent-id', agentDetection.agentId);
        }
      }

      res.status(200).send(sm.manifestJson);
      return;
    }

    // 2. Non-manifest traffic: add the x-stealthmark-* marker headers and pass through
    for (const [k, v] of Object.entries(sm.responseHeaders)) {
      res.setHeader(k, v);
    }

    if (agentDetection.isAgent) {
      res.setHeader('x-stealthmark-agent-detected', 'true');
      if (agentDetection.agentId) {
        res.setHeader('x-stealthmark-agent-id', agentDetection.agentId);
      }
    }

    next();
  };
}
