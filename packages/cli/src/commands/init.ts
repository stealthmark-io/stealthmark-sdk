// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — init command
// Writes a starter StealthMark middleware file for Next.js, Express or Fastify
// ═══════════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';
import { discoverCapabilities } from '@stealthmark/core';

export type Framework = 'next' | 'express' | 'fastify' | 'unknown';

export interface InitOptions {
  cwd?: string;
  name?: string;
  force?: boolean;
}

export interface InitResult {
  success: boolean;
  framework: Framework;
  filePath: string;
  capabilitiesCount: number;
  message: string;
  /** Framework-specific steps the user still has to do by hand */
  nextSteps: string[];
}

interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(cwd: string): PackageJsonShape | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}

export function detectFramework(cwd: string): Framework {
  const pkg = readPackageJson(cwd);
  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps['next']) return 'next';
    if (allDeps['express']) return 'express';
    if (allDeps['fastify']) return 'fastify';
  }

  if (
    fs.existsSync(path.join(cwd, 'next.config.js')) ||
    fs.existsSync(path.join(cwd, 'next.config.mjs')) ||
    fs.existsSync(path.join(cwd, 'next.config.ts'))
  ) {
    return 'next';
  }

  return 'unknown';
}

function frameworkLabel(framework: Exclude<Framework, 'unknown'>): string {
  switch (framework) {
    case 'next':
      return 'Next.js';
    case 'express':
      return 'Express';
    case 'fastify':
      return 'Fastify';
  }
}

export function runInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd || process.cwd();
  const framework = detectFramework(cwd);

  if (framework === 'unknown') {
    return {
      success: false,
      framework,
      filePath: '',
      capabilitiesCount: 0,
      message: 'No Next.js, Express or Fastify project detected. No file was written.',
      nextSteps: [],
    };
  }

  const siteName = options.name || readPackageJson(cwd)?.name || 'My App';
  const discoveredCaps = framework === 'next' ? discoverCapabilities({ rootDir: cwd }) : [];
  const capsCode = JSON.stringify(discoveredCaps, null, 2);

  const targetPath =
    framework === 'next'
      ? fs.existsSync(path.join(cwd, 'src'))
        ? path.join(cwd, 'src', 'middleware.ts')
        : path.join(cwd, 'middleware.ts')
      : path.join(cwd, 'stealthmark.middleware.ts');

  if (fs.existsSync(targetPath) && !options.force) {
    return {
      success: false,
      framework,
      filePath: targetPath,
      capabilitiesCount: discoveredCaps.length,
      message: `File already exists at ${targetPath}. Use --force to overwrite.`,
      nextSteps: [],
    };
  }

  let template: string;
  let nextSteps: string[];

  if (framework === 'next') {
    template = `import { stealthmark } from '@stealthmark/next';

export default stealthmark({
  siteName: ${JSON.stringify(siteName)},
  capabilities: ${capsCode},
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
`;
    nextSteps = ['Install @stealthmark/next, then restart your dev server and open /.well-known/agent.json'];
  } else if (framework === 'fastify') {
    template = `import { stealthmarkFastify } from '@stealthmark/express';

export const stealthmarkHook = stealthmarkFastify({
  siteName: ${JSON.stringify(siteName)},
  capabilities: ${capsCode},
});
`;
    nextSteps = [
      'Install @stealthmark/express',
      "Register the hook before your routes: fastify.addHook('preHandler', stealthmarkHook)",
    ];
  } else {
    template = `import { stealthmark } from '@stealthmark/express';

export const stealthmarkMiddleware = stealthmark({
  siteName: ${JSON.stringify(siteName)},
  capabilities: ${capsCode},
});
`;
    nextSteps = ['Install @stealthmark/express', 'Add app.use(stealthmarkMiddleware) before your routes'];
  }

  fs.writeFileSync(targetPath, template, 'utf8');

  return {
    success: true,
    framework,
    filePath: targetPath,
    capabilitiesCount: discoveredCaps.length,
    message: `Generated ${frameworkLabel(framework)} StealthMark middleware at ${targetPath}`,
    nextSteps,
  };
}
