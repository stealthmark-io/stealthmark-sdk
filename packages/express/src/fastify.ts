// ═══════════════════════════════════════════════════════════════════
// @stealthmark/express — Fastify Hook Plugin
// Detects self-identified AI agents, serves the agent manifest and meters agent traffic for Fastify apps
// ═══════════════════════════════════════════════════════════════════

import { createStealthMark, type StealthMarkConfig } from '@stealthmark/core';
import { NEGOTIATED_CACHE_CONTROL, isManifestPath, meterAgentRequest, meterBlockedRequest, negotiatedVary } from './meter.js';

export interface FastifyRequestLike {
  method?: string;
  url?: string;
  protocol?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface FastifyReplyLike {
  header(name: string, value: string): FastifyReplyLike;
  /** Present on real Fastify replies; used to keep a Vary header that earlier hooks already set. */
  getHeader?(name: string): unknown;
  code(statusCode: number): FastifyReplyLike;
  send(payload: unknown): FastifyReplyLike;
}

export type FastifyHookDone = (err?: Error) => void;

const BLOCKED_BODY = { error: 'agent_blocked', message: 'This site does not accept automated agent traffic.' };

function markNegotiated(reply: FastifyReplyLike): void {
  reply.header('Vary', negotiatedVary(reply.getHeader?.('Vary')));
  reply.header('Cache-Control', NEGOTIATED_CACHE_CONTROL);
}

/**
 * Creates a Fastify preHandler hook that serves the agent manifest, applies `agentPolicy`
 * and meters requests from agents that identify themselves.
 */
export function stealthmarkFastify(config: StealthMarkConfig) {
  const sm = createStealthMark(config);

  return function stealthmarkPreHandler(
    request: FastifyRequestLike,
    reply: FastifyReplyLike,
    done: FastifyHookDone
  ): void {
    const rawPath = request.url || '/';
    const pathOnly = rawPath.split('?')[0];

    const headersRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
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
      meterBlockedRequest(sm, headersRecord, agentDetection, pathOnly, request.method);
      for (const [k, v] of Object.entries(sm.responseHeaders)) {
        reply.header(k, v);
      }
      markNegotiated(reply);
      reply.code(403).send(BLOCKED_BODY);
      return;
    }

    meterAgentRequest(sm, headersRecord, agentDetection, pathOnly, request.method);

    if (servesManifest) {
      reply
        .header('Content-Type', 'application/agent+json; charset=utf-8')
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-stealthmark-agent');
      if (!isWellKnown) markNegotiated(reply);

      for (const [k, v] of Object.entries(sm.responseHeaders)) {
        reply.header(k, v);
      }

      if (agentDetection.isAgent) {
        reply.header('x-stealthmark-agent-detected', 'true');
        if (agentDetection.agentId) {
          reply.header('x-stealthmark-agent-id', agentDetection.agentId);
        }
      }

      reply.code(200).send(sm.manifest);
      return;
    }

    for (const [k, v] of Object.entries(sm.responseHeaders)) {
      reply.header(k, v);
    }

    if (agentDetection.isAgent) {
      reply.header('x-stealthmark-agent-detected', 'true');
      if (agentDetection.agentId) {
        reply.header('x-stealthmark-agent-id', agentDetection.agentId);
      }
    }

    done();
  };
}
