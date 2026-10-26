#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — Binary Executable
// CLI interface for stealthmark init, verify, and audit
// ═══════════════════════════════════════════════════════════════════

import { runInit } from './commands/init.js';
import { runVerify } from './commands/verify.js';
import { runAudit } from './commands/audit.js';

const VERSION = '0.1.5';

function printHelp() {
  console.log(`
StealthMark CLI (v${VERSION})
Command-line tool that scaffolds StealthMark middleware, checks agent manifests, and runs passive AI-readiness audits.

Usage:
  stealthmark <command> [options]

Commands:
  init [options]       Write a starter StealthMark middleware file (Next.js, Express or Fastify)
  verify <url>         Check whether a site serves a StealthMark agent manifest
  audit <domain>       Run a passive web & AI-surface readiness audit against a domain
  --version, -v        Show version
  --help, -h           Show this help message

Options (for init):
  --name <siteName>    Specify site name for the manifest
  --force              Overwrite existing middleware file

Options (for audit):
  --json               Output raw JSON report
  --markdown           Output formatted Markdown report
  --no-color           Disable terminal ANSI colors
  --gateway <url>      Custom StealthMark Gateway URL

Examples:
  stealthmark init
  stealthmark verify https://your-site.example
  stealthmark audit example.com
  stealthmark audit example.com --markdown
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    console.log(`v${VERSION}`);
    process.exit(0);
  }

  if (command === 'init') {
    const force = args.includes('--force');
    const nameIdx = args.indexOf('--name');
    const name = nameIdx !== -1 ? args[nameIdx + 1] : undefined;

    console.log('Detecting framework and scanning API routes...');
    const result = runInit({ cwd: process.cwd(), name, force });

    if (result.success) {
      console.log(result.message);
      console.log(`Framework: ${result.framework}`);
      console.log(`Capabilities discovered: ${result.capabilitiesCount}`);
      console.log('\nNext steps:');
      for (const step of result.nextSteps) {
        console.log(`  - ${step}`);
      }
      process.exit(0);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  }

  if (command === 'verify') {
    const targetUrl = args[1];
    if (!targetUrl) {
      console.error('Usage: stealthmark verify <url>');
      process.exit(1);
    }

    console.log(`Checking ${targetUrl} for a StealthMark agent manifest...\n`);

    const report = await runVerify(targetUrl);

    for (const check of report.checks) {
      const icon = check.passed ? 'PASS' : 'FAIL';
      console.log(`${icon}  ${check.name}: ${check.details}`);
    }

    const total = report.checks.length;
    const failed = report.checks.filter((c) => !c.passed).length;

    console.log('\n=======================================================');
    if (report.overallPassed) {
      console.log(`All ${total} checks passed.`);
      process.exit(0);
    } else {
      console.log(`${failed} of ${total} checks failed. See https://stealthmark.io/docs.`);
      process.exit(1);
    }
  }

  if (command === 'audit') {
    const target = args[1];
    if (!target || target.startsWith('--')) {
      console.error('Usage: stealthmark audit <domain> [options]');
      console.error('Example: stealthmark audit example.com');
      process.exit(1);
    }

    const json = args.includes('--json');
    const markdown = args.includes('--markdown');
    const noColor = args.includes('--no-color');
    const gatewayIdx = args.indexOf('--gateway');
    const gateway = gatewayIdx !== -1 ? args[gatewayIdx + 1] : undefined;

    const result = await runAudit(target, { json, markdown, noColor, gateway });

    if (result.output) {
      console.log(result.output);
    }

    if (result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Fatal CLI error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
