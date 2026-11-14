import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAudit,
  normalizeTargetDomain,
  formatTerminalReport,
  formatMarkdownReport,
  type AuditReport,
} from '../commands/audit.js';

describe('@stealthmark/cli — audit command', () => {
  const sampleReport: AuditReport = {
    domain: 'example.com',
    audited_at: '2026-10-17T12:00:00.000Z',
    summary: {
      counts: { pass: 14, warn: 2, fail: 0, info: 1, error: 0 },
      by_section: {
        transport: { pass: 3, warn: 0, fail: 0, info: 0, error: 0 },
        dns: { pass: 4, warn: 1, fail: 0, info: 0, error: 0 },
        crawl_policy: { pass: 3, warn: 0, fail: 0, info: 0, error: 0 },
        ai_surface: { pass: 2, warn: 1, fail: 0, info: 1, error: 0 },
        headers: { pass: 2, warn: 0, fail: 0, info: 0, error: 0 },
      },
    },
    sections: {
      transport: [
        { id: 'https_ok', title: 'HTTPS Availability', status: 'pass', detail: 'Answers HTTP 200' },
      ],
      dns: [
        { id: 'caa_record', title: 'CAA Authority', status: 'warn', detail: 'Missing CAA record', recommendation: 'Add CAA' },
      ],
      crawl_policy: [
        { id: 'robots_txt', title: 'robots.txt Presence', status: 'pass', detail: 'Found robots.txt' },
      ],
      ai_surface: [
        { id: 'llms_txt', title: 'llms.txt File', status: 'warn', detail: 'No /llms.txt' },
      ],
      headers: [
        { id: 'csp_header', title: 'Content-Security-Policy', status: 'pass', detail: 'CSP enabled' },
      ],
    },
    limitations: [
      'Passive audit based strictly on publicly observable DNS records and HTTP responses.',
      'No synthetic score or arbitrary rating is assigned.',
    ],
  };

  describe('normalizeTargetDomain', () => {
    it('normalizes plain domains', () => {
      expect(normalizeTargetDomain('example.com')).toBe('example.com');
      expect(normalizeTargetDomain('SUB.DOMAIN.ORG')).toBe('sub.domain.org');
    });

    it('extracts host from full URLs', () => {
      expect(normalizeTargetDomain('https://example.com/some/path?query=1')).toBe('example.com');
      expect(normalizeTargetDomain('http://api.test.io:8080/v1')).toBe('api.test.io');
    });

    it('strips trailing dots and whitespace', () => {
      expect(normalizeTargetDomain('  example.com.  ')).toBe('example.com');
    });

    it('strips only the trailing run of dots, however long', () => {
      expect(normalizeTargetDomain(`Example.COM${'.'.repeat(10_000)}`)).toBe('example.com');
      expect(normalizeTargetDomain('a..b.')).toBe('a..b');
      expect(normalizeTargetDomain('...')).toBe('');
    });

    it('returns empty string on empty input', () => {
      expect(normalizeTargetDomain('')).toBe('');
      expect(normalizeTargetDomain('   ')).toBe('');
    });
  });

  describe('formatTerminalReport', () => {
    it('formats terminal text with counts and sections', () => {
      const output = formatTerminalReport(sampleReport, false);
      expect(output).toContain('StealthMark Passive Readiness Audit');
      expect(output).toContain('Target domain: example.com');
      expect(output).toContain('14 PASS | 2 WARN | 0 FAIL | 1 INFO');
      expect(output).toContain('Transport & TLS');
      expect(output).toContain('HTTPS Availability');
      expect(output).toContain('Notice & Limitations:');
      expect(output).not.toContain('\x1b[');
    });

    it('includes ANSI escape codes when useColor is true', () => {
      const colored = formatTerminalReport(sampleReport, true);
      expect(colored).toContain('\x1b[');
      expect(colored).toContain('example.com');
    });

    const hostileSiteText = {
      domain: 'evil\x1b]0;pwned\x07.example',
      title: 'Title \x1b[2J\x1b[Hcleared\x9b31m',
      detail: 'Found\r\n  ✓ PASS   Forged check\x08\x08\x08\x08\x08\x08\x08\x08\ttabbed',
      recommendation: 'Add \u202eevil\u2069 \u2066x\u2069\u061c\u200f\u200e record\x7f\x00\x85',
      limitation: 'Note\x1b[1;31m red \x9d8;;http://evil\x07link',
    };
    const reportWithSiteText = (text: typeof hostileSiteText): AuditReport => ({
      ...sampleReport,
      domain: text.domain,
      sections: {
        ...sampleReport.sections,
        dns: [{ id: 'caa_record', title: text.title, status: 'warn', detail: text.detail, recommendation: text.recommendation }],
      },
      limitations: [text.limitation],
    });
    const unsafeInTerminal = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

    it('drops control and bidi characters from the audited site’s text, so it cannot restyle, move or forge lines of the report', () => {
      const output = formatTerminalReport(reportWithSiteText(hostileSiteText), false);
      expect(output).toContain('Target domain: evil]0;pwned.example\n');
      expect(output).toContain('Title [2J[Hcleared31m\n');
      expect(output).toContain('         Found   ✓ PASS   Forged check tabbed\n');
      expect(output).toContain('         ↳ Recommendation: Add evil x record\n');
      expect(output).toContain('  • Note[1;31m red 8;;http://evillink\n');
      expect(output).not.toMatch(unsafeInTerminal);
      const benign = reportWithSiteText({ domain: 'a.example', title: 't', detail: 'd', recommendation: 'r', limitation: 'l' });
      expect(output.split('\n')).toHaveLength(formatTerminalReport(benign, false).split('\n').length);
    });

    it('keeps the CLI’s own colors around the cleaned site text', () => {
      const colored = formatTerminalReport(reportWithSiteText(hostileSiteText), true);
      expect(colored).toContain('\x1b[1mTitle [2J[Hcleared31m\x1b[0m');
      expect(colored).toContain('\x1b[2mFound   ✓ PASS   Forged check tabbed\x1b[0m');
      expect(colored.replace(/\x1b\[\d+m/g, '')).not.toMatch(unsafeInTerminal);
    });
  });

  describe('formatMarkdownReport', () => {
    it('generates a clean markdown document', () => {
      const md = formatMarkdownReport(sampleReport);
      expect(md).toContain('# StealthMark Readiness Audit Report: example.com');
      expect(md).toContain('| Transport & TLS | 3 | 0 | 0 | 0 |');
      expect(md).toContain('#### [PASS] HTTPS Availability');
      expect(md).toContain('Counts only — no arbitrary 0–100 score assigned.');
    });

    it('escapes the audited site’s title, detail and recommendation, so they cannot add links, markup or lines', () => {
      const md = formatMarkdownReport({
        ...sampleReport,
        sections: {
          ...sampleReport.sections,
          headers: [{ id: 'csp_header', title: 'Evil <img src=x> ##', status: 'warn', detail: '[click](https://evil.example)\n# injected *bold* `code` ~~gone~~ _em_ \\', recommendation: 'Add [x](https://evil.example)\n# to _dmarc.example.com' }],
        },
      });
      expect(md).toContain('#### [WARN] Evil &lt;img src=x> \\##\n');
      expect(md).toContain('- **Detail**: \\[click\\](https://evil.example) # injected \\*bold\\* \\`code\\` &#126;&#126;gone&#126;&#126; \\_em\\_ \\\\\n');
      expect(md).toContain('- **Recommendation**: Add \\[x\\](https://evil.example) # to \\_dmarc.example.com\n');
      expect(md.split('\n').some((line) => line.startsWith('# injected'))).toBe(false);
    });

    it('writes `<` as an entity, turns U+2028 and U+2029 into spaces and drops trailing whitespace, so a GFM autolink, a marked line break or a list’s trimmed tail cannot add markup', () => {
      const md = formatMarkdownReport({
        ...sampleReport,
        sections: {
          ...sampleReport.sections,
          headers: [{ id: 'csp_header', title: 'Evil\u2028# injected', status: 'warn', detail: 'http://x/<img src=x onerror=1>', recommendation: 'Fix\u2029# it\t\u00a0' }],
        },
      });
      expect(md).toContain('#### [WARN] Evil # injected\n');
      expect(md).toContain('- **Detail**: http://x/&lt;img src=x onerror=1>\n');
      expect(md).toContain('- **Recommendation**: Fix # it\n');
      expect(md).not.toContain('<img');
      expect(md).not.toMatch(/[\u2028\u2029]/);
    });

    it('writes `~` as an entity, so a GFM autolink that swallows the backslash before it cannot open or close a strikethrough', () => {
      const md = formatMarkdownReport({
        ...sampleReport,
        sections: {
          ...sampleReport.sections,
          headers: [{ id: 'csp_header', title: 'http://e~. x~y', status: 'warn', detail: 'http://e~( a~b' }],
        },
      });
      expect(md).toContain('#### [WARN] http://e&#126;. x&#126;y\n');
      expect(md).toContain('- **Detail**: http://e&#126;( a&#126;b\n');
      expect(md).not.toContain('~');
    });
  });

  describe('runAudit', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('returns error without calling fetch for invalid domain', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const result = await runAudit('   ');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid target');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches from gateway and returns success when fail count is 0', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleReport,
      } as Response);

      const result = await runAudit('https://example.com', {
        gateway: 'https://gateway.custom.internal',
        noColor: true,
      });

      expect(result.success).toBe(true);
      expect(result.domain).toBe('example.com');
      expect(result.report).toBeDefined();
      expect(result.output).toContain('Target domain: example.com');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://gateway.custom.internal/api/v2/audit?domain=example.com',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });

    it('uses the public gateway when no gateway option or env var is set', async () => {
      vi.stubEnv('STEALTHMARK_GATEWAY_URL', undefined);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleReport,
      } as Response);

      await runAudit('example.com', { noColor: true });
      vi.unstubAllEnvs();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://gateway.stealthmark.io/api/v2/audit?domain=example.com',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('returns valid JSON when --json option is passed', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleReport,
      } as Response);

      const result = await runAudit('example.com', { json: true });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.domain).toBe('example.com');
      expect(parsed.summary.counts.pass).toBe(14);
    });

    it('returns Markdown when --markdown option is passed', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleReport,
      } as Response);

      const result = await runAudit('example.com', { markdown: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('# StealthMark Readiness Audit Report: example.com');
    });

    it('marks result as failure if fail count > 0', async () => {
      const reportWithFails: AuditReport = {
        ...sampleReport,
        summary: {
          ...sampleReport.summary,
          counts: { pass: 10, warn: 2, fail: 2, info: 1, error: 0 },
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => reportWithFails,
      } as Response);

      const result = await runAudit('example.com');
      expect(result.success).toBe(false);
    });

    it('handles HTTP 429 rate limit cleanly', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ detail: 'Rate limit' }),
      } as Response);

      const result = await runAudit('example.com');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit exceeded');
    });

    it('handles HTTP 503 gateway busy cleanly', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'Busy' }),
      } as Response);

      const result = await runAudit('example.com');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Gateway busy');
    });

    it('handles network failure cleanly', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const result = await runAudit('example.com');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error connecting to StealthMark Gateway');
    });
  });
});
