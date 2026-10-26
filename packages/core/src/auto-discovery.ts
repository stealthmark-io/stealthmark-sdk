// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Route Discovery (Node only)
// Lists Next.js App Router route handlers as manifest capabilities
// ═══════════════════════════════════════════════════════════════════

import type { Capability, HttpMethod } from './types.js';
import * as fs from 'fs';
import * as path from 'path';

export interface RouteDiscoveryOptions {
  /** Root directory to scan from (defaults to process.cwd()) */
  rootDir?: string;
  /** Directories to scan (defaults to `src/app/api` and `app/api` under `rootDir`) */
  apiPaths?: string[];
  /**
   * Opt-in: routes whose path contains one of these keywords are published with `hitl: true`.
   * Empty by default, so discovery never guesses which routes need human approval.
   */
  hitlKeywords?: string[];
}

const HTTP_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const METHOD_FUNCTION_EXPORT = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const METHOD_CONST_EXPORT = /\bexport\s+(?:const|let|var)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;

function detectExportedMethods(source: string): Set<HttpMethod> {
  const methods = new Set<HttpMethod>();

  for (const pattern of [METHOD_FUNCTION_EXPORT, METHOD_CONST_EXPORT]) {
    for (const match of source.matchAll(pattern)) {
      methods.add(match[1] as HttpMethod);
    }
  }

  for (const list of source.matchAll(EXPORT_LIST)) {
    for (const specifier of list[1].split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const exportedName = parts[parts.length - 1]?.trim();
      if (exportedName && HTTP_METHODS.includes(exportedName)) {
        methods.add(exportedName as HttpMethod);
      }
    }
  }

  return methods;
}

/**
 * Lists Next.js App Router route handlers (`route.ts`, `route.js`, `route.mts`, `route.mjs`) found under
 * `app/api` or `src/app/api` as capabilities. A handler is listed once per HTTP method it exports.
 * Routes whose exported methods cannot be determined are skipped.
 *
 * It does not scan Express, Fastify or Pages Router routes, and it assumes nothing about pricing or
 * human approval. Needs Node (`fs`): do not call it from Edge or browser code.
 */
export function discoverCapabilities(options: RouteDiscoveryOptions = {}): Capability[] {
  const rootDir = options.rootDir || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.');
  const hitlKeywords = (options.hitlKeywords ?? []).map((kw) => kw.toLowerCase());
  const capabilities: Capability[] = [];

  const candidateDirs = options.apiPaths || [
    path.join(rootDir, 'src', 'app', 'api'),
    path.join(rootDir, 'app', 'api'),
  ];

  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      scanAppApiDirectory(dir, dir, capabilities, hitlKeywords);
      break; // Only scan the first matching API root directory to prevent duplicate routes
    }
  }

  return capabilities;
}

function scanAppApiDirectory(
  currentDir: string,
  apiRootDir: string,
  out: Capability[],
  hitlKeywords: string[]
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      scanAppApiDirectory(fullPath, apiRootDir, out, hitlKeywords);
    } else if (
      entry.isFile() &&
      (entry.name === 'route.ts' ||
        entry.name === 'route.js' ||
        entry.name === 'route.mts' ||
        entry.name === 'route.mjs')
    ) {
      // Derive endpoint path relative to api root
      const relDir = path.relative(apiRootDir, currentDir);
      const endpoint = '/api' + (relDir ? '/' + relDir.replace(/\\/g, '/') : '');

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const detectedMethods = detectExportedMethods(content);

        for (const method of detectedMethods) {
          const slug = endpoint
            .replace(/^\/api\/?/, '')
            .replace(/\//g, '-')
            .replace(/\[([^\]]+)\]/g, '$1') || 'root';

          const id = `${slug}-${method.toLowerCase()}`;
          const isHitl = hitlKeywords.some((kw) => endpoint.toLowerCase().includes(kw));

          out.push({
            id,
            endpoint,
            method,
            description: `API endpoint for ${endpoint} (${method})`,
            ...(isHitl ? { hitl: true } : {}),
          });
        }
      } catch {
        // Silently skip unreadable files
      }
    }
  }
}
