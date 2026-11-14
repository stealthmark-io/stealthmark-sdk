#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — Binary Executable
// CLI interface for stealthmark init, verify, and audit
// ═══════════════════════════════════════════════════════════════════

import { runInit } from './commands/init.js';
import { runVerify } from './commands/verify.js';
import { runAudit } from './commands/audit.js';
import { runSkillAudit } from './commands/skill-audit.js';
import { runLocalDoctorV5, runPdfInspector } from './commands/doctor-v5.js';

const VERSION = '5.1.0';

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
  skill-audit <path>   Audit local agent skill(s) for supply-chain, hooks, and injection risks (alias: audit-skill)
  doctor               Audit local workstation/server for Node2Shell, SUID PrivEsc, Docker & Supply-Chain IOCs
  pdf-check <file.pdf> Scan a PDF resume/invoice for /JavaScript, /Launch, /OpenAction & AI prompt injections
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

Options (for skill-audit):
  --json               Output raw JSON report
  --markdown           Output formatted Markdown report
  --no-color           Disable terminal ANSI colors
  --no-spector         Disable SkillSpector bridge
  --spector            Force SkillSpector bridge execution

Examples:
  stealthmark init
  stealthmark verify https://your-site.example
  stealthmark audit example.com
  stealthmark audit example.com --markdown
  stealthmark skill-audit ./my-skill
  stealthmark skill-audit ./skills-dir --markdown
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

  if (command === 'skill-audit' || command === 'audit-skill') {
    const target = args[1];
    if (!target || target.startsWith('--')) {
      console.error('Usage: stealthmark skill-audit <path> [options]');
      console.error('Example: stealthmark skill-audit ./my-skill --markdown');
      process.exit(1);
    }

    const json = args.includes('--json');
    const markdown = args.includes('--markdown');
    const noColor = args.includes('--no-color');
    const noSpector = args.includes('--no-spector');
    const spector = args.includes('--spector');

    const result = await runSkillAudit(target, { json, markdown, noColor, noSpector, spector });

    if (result.output) {
      console.log(result.output);
    }

    if (result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }

  if (command === 'doctor') {
    await runLocalDoctorV5();
    process.exit(0);
  }

  if (command === 'pdf-check') {
    const file = args[1];
    if (!file) {
      console.error('Usage: stealthmark pdf-check <file.pdf>');
      process.exit(1);
    }
    await runPdfInspector(file);
    process.exit(0);
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error('Fatal CLI error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
