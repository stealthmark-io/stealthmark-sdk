// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — audit command
// Lightweight client for GET /api/v2/audit (Passive Readiness Auditor)
// ═══════════════════════════════════════════════════════════════════

export interface AuditCheckItem {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'info' | 'error';
  detail: string;
  recommendation?: string;
}

export interface SectionCounts {
  pass: number;
  warn: number;
  fail: number;
  info: number;
  error: number;
}

export interface AuditSummary {
  counts: SectionCounts;
  by_section: Record<string, SectionCounts>;
}

export interface AuditReport {
  domain: string;
  audited_at: string;
  summary: AuditSummary;
  sections: {
    transport: AuditCheckItem[];
    dns: AuditCheckItem[];
    crawl_policy: AuditCheckItem[];
    ai_surface: AuditCheckItem[];
    headers: AuditCheckItem[];
  };
  limitations: string[];
}

export interface AuditOptions {
  gateway?: string;
  json?: boolean;
  markdown?: boolean;
  noColor?: boolean;
}

export interface AuditResult {
  success: boolean;
  domain: string;
  report?: AuditReport;
  output: string;
  error?: string;
}

export const DEFAULT_GATEWAY_URL = 'https://gateway.stealthmark.io';
const REQUEST_TIMEOUT_MS = 25_000;

export const SECTION_METADATA: Record<string, { title: string; desc: string }> = {
  transport: {
    title: 'Transport & TLS',
    desc: 'HTTPS availability, HTTP-to-HTTPS redirect, and HSTS enforcement',
  },
  dns: {
    title: 'DNS Security Records',
    desc: 'Public address resolution, CAA authority rules, SPF and DMARC identity records',
  },
  crawl_policy: {
    title: 'Crawl Policy & Robots',
    desc: 'robots.txt presence, explicit directives for AI crawlers, and sitemap reference',
  },
  ai_surface: {
    title: 'AI Discovery Surface',
    desc: '/llms.txt context index, /.well-known/agent.json manifest, and Schema.org structured data',
  },
  headers: {
    title: 'Defense Headers',
    desc: 'Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, and clickjacking protection',
  },
};

export function normalizeTargetDomain(target: string): string {
  const trimmed = (target || '').trim();
  if (!trimmed) return '';

  let host = trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
    } catch {
      host = trimmed.replace(/^https?:\/\//, '').split('/')[0] || '';
    }
  } else {
    host = trimmed.split('/')[0] || '';
  }

  // Remove trailing dots, default port if any, and lowercase
  host = host.split(':')[0] || '';
  return host.toLowerCase().replace(/\.+$/, '');
}

export function formatTerminalReport(report: AuditReport, useColor: boolean = true): string {
  const c = {
    reset: useColor ? '\x1b[0m' : '',
    bold: useColor ? '\x1b[1m' : '',
    dim: useColor ? '\x1b[2m' : '',
    green: useColor ? '\x1b[32m' : '',
    yellow: useColor ? '\x1b[33m' : '',
    red: useColor ? '\x1b[31m' : '',
    cyan: useColor ? '\x1b[36m' : '',
    magenta: useColor ? '\x1b[35m' : '',
  };

  const lines: string[] = [];

  lines.push(`${c.bold}StealthMark Passive Readiness Audit${c.reset}`);
  lines.push(`${c.dim}Target domain:${c.reset} ${c.bold}${report.domain}${c.reset}`);
  lines.push(`${c.dim}Audited at:${c.reset}   ${new Date(report.audited_at).toUTCString()}`);
  lines.push('');

  const counts = report.summary.counts;
  lines.push(
    `${c.bold}Status Summary:${c.reset} ` +
      `${c.green}${counts.pass} PASS${c.reset} | ` +
      `${c.yellow}${counts.warn} WARN${c.reset} | ` +
      `${c.red}${counts.fail} FAIL${c.reset} | ` +
      `${c.cyan}${counts.info} INFO${c.reset}` +
      (counts.error > 0 ? ` | ${c.red}${counts.error} ERROR${c.reset}` : '')
  );
  lines.push(`${c.dim}(Counts only — zero synthetic scores assigned)${c.reset}`);
  lines.push('');

  for (const [secKey, meta] of Object.entries(SECTION_METADATA)) {
    const secCounts = report.summary.by_section[secKey] || { pass: 0, warn: 0, fail: 0, info: 0, error: 0 };
    lines.push(
      `${c.bold}${meta.title}${c.reset} ${c.dim}(${secCounts.pass} pass, ${secCounts.warn} warn, ${secCounts.fail} fail)${c.reset}`
    );

    const items = report.sections[secKey as keyof typeof report.sections] || [];
    for (const item of items) {
      let icon = '[INFO]';
      let color = c.cyan;
      if (item.status === 'pass') {
        icon = '✓ PASS';
        color = c.green;
      } else if (item.status === 'warn') {
        icon = '⚠ WARN';
        color = c.yellow;
      } else if (item.status === 'fail') {
        icon = '✗ FAIL';
        color = c.red;
      } else if (item.status === 'error') {
        icon = '‼ ERROR';
        color = c.red;
      }

      lines.push(`  ${color}${icon.padEnd(8)}${c.reset} ${c.bold}${item.title}${c.reset}`);
      lines.push(`         ${c.dim}${item.detail}${c.reset}`);
      if (item.recommendation) {
        lines.push(`         ${c.magenta}↳ Recommendation:${c.reset} ${item.recommendation}`);
      }
    }
    lines.push('');
  }

  lines.push(`${c.bold}Notice & Limitations:${c.reset}`);
  for (const lim of report.limitations) {
    lines.push(`  • ${c.dim}${lim}${c.reset}`);
  }
  lines.push('');
  lines.push(`${c.dim}Generated by StealthMark Passive Readiness Auditor · https://stealthmark.io/scan${c.reset}`);

  return lines.join('\n');
}

export function formatMarkdownReport(report: AuditReport): string {
  const { domain, audited_at, summary, sections, limitations } = report;
  const dateFormatted = new Date(audited_at).toUTCString();

  let md = `# StealthMark Readiness Audit Report: ${domain}\n\n`;
  md += `> Audited on: **${dateFormatted}**  \n`;
  md += `> Status breakdown: **${summary.counts.pass} Pass**, **${summary.counts.warn} Warn**, **${summary.counts.fail} Fail**, **${summary.counts.info} Info**  \n`;
  md += `> Scoring policy: *Counts only — no arbitrary 0–100 score assigned.*\n\n`;

  md += `## Summary by Section\n\n`;
  md += `| Section | Pass | Warn | Fail | Info |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: |\n`;
  for (const [key, meta] of Object.entries(SECTION_METADATA)) {
    const c = summary.by_section[key] || { pass: 0, warn: 0, fail: 0, info: 0, error: 0 };
    md += `| ${meta.title} | ${c.pass} | ${c.warn} | ${c.fail} | ${c.info} |\n`;
  }
  md += `\n---\n\n`;

  md += `## Detailed Findings\n\n`;
  for (const [secKey, meta] of Object.entries(SECTION_METADATA)) {
    const items = sections[secKey as keyof typeof sections] || [];
    md += `### ${meta.title}\n\n`;
    md += `*${meta.desc}*\n\n`;
    for (const item of items) {
      const badge = item.status.toUpperCase();
      md += `#### [${badge}] ${item.title}\n`;
      md += `- **Detail**: ${item.detail}\n`;
      if (item.recommendation) {
        md += `- **Recommendation**: ${item.recommendation}\n`;
      }
      md += `\n`;
    }
  }

  md += `## Notice & Limitations\n\n`;
  for (const lim of limitations) {
    md += `- ${lim}\n`;
  }
  md += `\n---\n*Generated by StealthMark Passive Readiness Auditor · https://stealthmark.io/scan*\n`;

  return md;
}

export async function runAudit(target: string, options: AuditOptions = {}): Promise<AuditResult> {
  const domain = normalizeTargetDomain(target);
  if (!domain) {
    const err = `Invalid target "${target}". Please specify a valid internet domain name (e.g. example.com).`;
    return {
      success: false,
      domain: target,
      output: err,
      error: err,
    };
  }

  const gatewayUrl = (options.gateway || process.env.STEALTHMARK_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/$/, '');
  const auditUrl = `${gatewayUrl}/api/v2/audit?domain=${encodeURIComponent(domain)}`;

  try {
    const res = await fetch(auditUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'StealthMarkCLI/0.1.7 (+https://stealthmark.io)',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      let errorDetail = `HTTP ${res.status}`;
      try {
        const errorJson = (await res.json()) as { detail?: string };
        if (errorJson.detail) {
          errorDetail = `${errorDetail}: ${errorJson.detail}`;
        }
      } catch {
        const text = await res.text().catch(() => '');
        if (text) errorDetail = `${errorDetail}: ${text}`;
      }

      if (res.status === 429) {
        errorDetail = 'Rate limit exceeded: maximum 10 audits per minute per IP. Please wait before retrying.';
      } else if (res.status === 503) {
        errorDetail = 'Gateway busy: maximum concurrent audits reached. Please retry in a few seconds.';
      } else if (res.status === 504) {
        errorDetail = 'Gateway timeout: target domain did not respond within the deadline.';
      }

      return {
        success: false,
        domain,
        output: `Audit failed for ${domain}: ${errorDetail}`,
        error: errorDetail,
      };
    }

    const report = (await res.json()) as AuditReport;

    let output: string;
    if (options.json) {
      output = JSON.stringify(report, null, 2);
    } else if (options.markdown) {
      output = formatMarkdownReport(report);
    } else {
      const disableColor = Boolean(options.noColor || process.env.NO_COLOR);
      output = formatTerminalReport(report, !disableColor);
    }

    const failedCount = (report.summary?.counts?.fail ?? 0) + (report.summary?.counts?.error ?? 0);
    const success = failedCount === 0;

    return {
      success,
      domain,
      report,
      output,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const formattedError = `Network error connecting to StealthMark Gateway (${gatewayUrl}): ${message}`;
    return {
      success: false,
      domain,
      output: formattedError,
      error: formattedError,
    };
  }
}
