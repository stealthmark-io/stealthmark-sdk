// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — skill-audit command
// Deterministic Supply-Chain & Agent Safety Gate for Agent Skills
// ═══════════════════════════════════════════════════════════════════

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';

export type SkillSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface SkillAuditFinding {
  id: string;
  severity: SkillSeverity;
  rule: string;
  file: string;
  line?: number;
  description: string;
  source?: 'stealthmark' | 'skillspector';
}

export interface SkillAuditReport {
  targetPath: string;
  scannedAt: string;
  skillsCount: number;
  filesScanned: number;
  riskScore: number;
  verdict: 'SAFE' | 'CAUTION' | 'DO NOT INSTALL';
  findings: SkillAuditFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  spectorBridge?: {
    available: boolean;
    executed: boolean;
    score?: number;
    issuesCount?: number;
    error?: string;
  };
}

export interface SkillAuditOptions {
  json?: boolean;
  markdown?: boolean;
  noColor?: boolean;
  spector?: boolean;
  noSpector?: boolean;
}

export interface SkillAuditResult {
  success: boolean;
  targetPath: string;
  report: SkillAuditReport;
  output: string;
  error?: string;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;
const HOOKS_RE = /^[ \t]*["']?hooks["']?\s*:/im;
const CONFIG_HIJACK_FILES = new Set(['.mcp.json', 'hooks.json']);
const BINARY_EXTENSIONS = new Set(['.pyc', '.pyo', '.so', '.dylib', '.dll', '.wasm']);
const MAX_SCAN_BYTES = 1_000_000; // 1 MB limit

interface PatternCheck {
  id: string;
  severity: SkillSeverity;
  rule: string;
  regex: RegExp;
  describe: (matched: string) => string;
}

const CONTENT_PATTERNS: PatternCheck[] = [
  // PIPE_TO_SHELL (CRITICAL)
  {
    id: 'PIPE_TO_SHELL',
    severity: 'CRITICAL',
    rule: 'Unsafe remote script pipe-to-shell or eval pipeline',
    regex: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
    describe: (m) => `Dangerous pipe-to-shell command pattern: "${m.trim()}"`,
  },
  {
    id: 'PIPE_TO_SHELL',
    severity: 'CRITICAL',
    rule: 'Unsafe shell process substitution with remote download',
    regex: /\b(ba|z)?sh\b[^\n]*(<\(|\$\()\s*(curl|wget)\b/i,
    describe: (m) => `Shell process substitution downloading remote code: "${m.trim()}"`,
  },
  {
    id: 'PIPE_TO_SHELL',
    severity: 'CRITICAL',
    rule: 'Obfuscated base64 decoded shell execution',
    regex: /base64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z)?sh\b/i,
    describe: (m) => `Base64 decoded shell pipeline: "${m.trim()}"`,
  },
  {
    id: 'PIPE_TO_SHELL',
    severity: 'CRITICAL',
    rule: 'Dynamic eval/exec of remote HTTP response',
    regex: /\b(eval|exec)\s*\([^\n]*\b(urlopen|requests\.get)\s*\(/i,
    describe: (m) => `Eval/exec of remote HTTP payload: "${m.trim()}"`,
  },
  {
    id: 'PIPE_TO_SHELL',
    severity: 'CRITICAL',
    rule: 'Dynamic eval/exec of decoded or decompressed bytecode',
    regex: /\b(eval|exec)\s*\(\s*(base64\.|b64decode|zlib\.|codecs\.decode|atob\()/i,
    describe: (m) => `Dynamic execution of decoded/decompressed code: "${m.trim()}"`,
  },

  // CREDENTIAL_OR_IMDS_ACCESS (HIGH)
  {
    id: 'CREDENTIAL_OR_IMDS_ACCESS',
    severity: 'HIGH',
    rule: 'Host SSH private key access',
    regex: /(?:~|\$HOME|\/Users\/[^\s\/'"]+|\/home\/[^\s\/'"]+)?\/\.ssh\/id_|\.ssh\/id_/i,
    describe: (m) => `Reference to sensitive host SSH identity keys: "${m.trim()}"`,
  },
  {
    id: 'CREDENTIAL_OR_IMDS_ACCESS',
    severity: 'HIGH',
    rule: 'Host AWS credentials access',
    regex: /(?:~|\$HOME|\/Users\/[^\s\/'"]+|\/home\/[^\s\/'"]+)?\/\.aws\/credentials|\.aws\/credentials/i,
    describe: (m) => `Reference to AWS credentials store: "${m.trim()}"`,
  },
  {
    id: 'CREDENTIAL_OR_IMDS_ACCESS',
    severity: 'HIGH',
    rule: 'Linux process environment variable inspection',
    regex: /\/proc\/(?:self|\d+|\*)\/environ/i,
    describe: (m) => `Inspection of /proc/*/environ containing process secrets: "${m.trim()}"`,
  },
  {
    id: 'CREDENTIAL_OR_IMDS_ACCESS',
    severity: 'HIGH',
    rule: 'Cloud Instance Metadata Service (IMDS) access',
    regex: /169\.254\.169\.254|metadata\.google\.internal/i,
    describe: (m) => `Cloud Instance Metadata Service (IMDS) endpoint probe: "${m.trim()}"`,
  },
  {
    id: 'CREDENTIAL_OR_IMDS_ACCESS',
    severity: 'HIGH',
    rule: 'macOS Keychain password extraction',
    regex: /\bsecurity\s+find-(?:generic|internet)-password\b/i,
    describe: (m) => `Invocation of macOS security CLI to read keychain passwords: "${m.trim()}"`,
  },

  // AGENT_CONFIG_SNOOPING (HIGH)
  {
    id: 'AGENT_CONFIG_SNOOPING',
    severity: 'HIGH',
    rule: 'Claude Code configuration snooping or tampering',
    regex: /(?:~|\$HOME|\/Users\/[^\s\/'"]+|\/home\/[^\s\/'"]+)?\/\.claude\/settings\.json|\.claude\/settings\.json/i,
    describe: (m) => `Access or alteration of Claude Code configuration: "${m.trim()}"`,
  },
  {
    id: 'AGENT_CONFIG_SNOOPING',
    severity: 'HIGH',
    rule: 'Gemini / Antigravity agent configuration snooping',
    regex: /(?:~|\$HOME|\/Users\/[^\s\/'"]+|\/home\/[^\s\/'"]+)?\/\.gemini\/config\/|\.gemini\/config\//i,
    describe: (m) => `Access or alteration of Gemini/Antigravity configuration: "${m.trim()}"`,
  },
  {
    id: 'AGENT_CONFIG_SNOOPING',
    severity: 'HIGH',
    rule: 'Rogue agent self-modification of SKILL.md (RA1)',
    regex: /(?:>|>>|tee\b|sed\s+-i|truncate\b|rm\b|cat\s+[^>\n]*>|echo\s+[^>\n]*>|fs\.writeFile|open\([^)\n]*,\s*['"][wa]['"]\)).{0,50}SKILL\.md|\bSKILL\.md\b.{0,25}(?:>|>>)/i,
    describe: (m) => `Self-modification or truncation pattern targeting SKILL.md: "${m.trim()}"`,
  },

  // UNATTENDED_INSTALL (MEDIUM)
  {
    id: 'UNATTENDED_INSTALL',
    severity: 'MEDIUM',
    rule: 'Breaking system packages python installation',
    regex: /pip\s+install\b[^\n]*--break-system-packages/i,
    describe: (m) => `System package override with --break-system-packages: "${m.trim()}"`,
  },
  {
    id: 'UNATTENDED_INSTALL',
    severity: 'MEDIUM',
    rule: 'Unattended uv tool package installation',
    regex: /uv\s+tool\s+install\b/i,
    describe: (m) => `Unattended tool installation via uv tool install: "${m.trim()}"`,
  },
];

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function resolveSkillSpectorBinary(): string | null {
  const candidate = path.join(os.homedir(), '.local', 'bin', 'skillspector');
  if (fs.existsSync(candidate)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not executable
    }
  }

  try {
    const out = child_process
      .execSync('which skillspector', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .trim();
    if (out && fs.existsSync(out)) {
      return out;
    }
  } catch {
    // not in PATH
  }

  return null;
}

function mapSpectorSeverity(sev?: string): SkillSeverity {
  const upper = String(sev || '').toUpperCase();
  if (upper === 'CRITICAL') return 'CRITICAL';
  if (upper === 'HIGH') return 'HIGH';
  if (upper === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
}

function collectFilesRecursively(dir: string, baseDir: string = dir): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      results.push(fullPath);
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...collectFilesRecursively(fullPath, baseDir));
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

function calculateRiskScore(findings: SkillAuditFinding[]): {
  score: number;
  verdict: 'SAFE' | 'CAUTION' | 'DO NOT INSTALL';
  summary: { critical: number; high: number; medium: number; low: number };
} {
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (const f of findings) {
    if (f.severity === 'CRITICAL') critical++;
    else if (f.severity === 'HIGH') high++;
    else if (f.severity === 'MEDIUM') medium++;
    else low++;
  }

  // Weightings: CRITICAL: 40, HIGH: 20, MEDIUM: 10, LOW: 5
  let rawScore = critical * 40 + high * 20 + medium * 10 + low * 5;
  if (critical > 0 && rawScore < 70) {
    rawScore = 70;
  }
  const score = Math.min(100, Math.max(0, rawScore));

  let verdict: 'SAFE' | 'CAUTION' | 'DO NOT INSTALL';
  if (critical > 0 || score >= 70) {
    verdict = 'DO NOT INSTALL';
  } else if (high > 0 || score >= 25) {
    verdict = 'CAUTION';
  } else {
    verdict = 'SAFE';
  }

  return { score, verdict, summary: { critical, high, medium, low } };
}

export function formatSkillAuditTerminal(report: SkillAuditReport, noColor = false): string {
  const c = noColor
    ? {
        reset: '',
        bold: '',
        dim: '',
        red: '',
        green: '',
        yellow: '',
        blue: '',
        magenta: '',
        cyan: '',
        gray: '',
      }
    : ANSI;

  const lines: string[] = [];
  lines.push(`${c.bold}${c.cyan}🛡️  StealthMark Skill Audit v5.1 — Agent Supply-Chain Security Gate${c.reset}`);
  lines.push(`${c.gray}Target:${c.reset} ${report.targetPath}`);
  lines.push(
    `${c.gray}Scanned:${c.reset} ${report.scannedAt}  |  ${c.gray}Skills Detected:${c.reset} ${report.skillsCount}  |  ${c.gray}Files Scanned:${c.reset} ${report.filesScanned}`
  );
  lines.push('');

  let verdictBadge = `${c.green}[SAFE]${c.reset}`;
  if (report.verdict === 'DO NOT INSTALL') {
    verdictBadge = `${c.bold}${c.red}[DO NOT INSTALL]${c.reset}`;
  } else if (report.verdict === 'CAUTION') {
    verdictBadge = `${c.bold}${c.yellow}[CAUTION]${c.reset}`;
  }

  lines.push(
    `Risk Score: ${c.bold}${report.riskScore} / 100${c.reset} ${verdictBadge}  (${c.red}${report.summary.critical} Critical${c.reset}, ${c.yellow}${report.summary.high} High${c.reset}, ${c.blue}${report.summary.medium} Medium${c.reset}, ${c.gray}${report.summary.low} Low${c.reset})`
  );

  if (report.spectorBridge) {
    const sb = report.spectorBridge;
    if (sb.executed) {
      lines.push(
        `${c.gray}SkillSpector Bridge:${c.reset} ${c.green}Active${c.reset} (Issues: ${sb.issuesCount ?? 0}, Risk Score: ${sb.score ?? 'N/A'})`
      );
    } else if (sb.available) {
      lines.push(`${c.gray}SkillSpector Bridge:${c.reset} Available (Not invoked / skipped)`);
    } else {
      lines.push(`${c.gray}SkillSpector Bridge:${c.reset} Not installed (Deterministic Pass 1 only)`);
    }
  }

  lines.push('');

  if (report.findings.length === 0) {
    lines.push(`${c.green}✔ No supply chain or execution anomalies detected.${c.reset}`);
  } else {
    lines.push(`${c.bold}Detected Findings (${report.findings.length}):${c.reset}`);
    for (const f of report.findings) {
      let sevColor = c.gray;
      if (f.severity === 'CRITICAL') sevColor = c.red;
      else if (f.severity === 'HIGH') sevColor = c.yellow;
      else if (f.severity === 'MEDIUM') sevColor = c.blue;

      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${sevColor}✖ [${f.severity}]${c.reset} ${c.bold}${f.id}${c.reset} (${loc})`);
      lines.push(`    ${f.description}`);
    }
  }

  lines.push('');
  if (report.verdict === 'SAFE') {
    lines.push(`${c.bold}${c.green}VERDICT: SAFE — Skill complies with deterministic agent safety boundaries.${c.reset}`);
  } else if (report.verdict === 'CAUTION') {
    lines.push(
      `${c.bold}${c.yellow}VERDICT: CAUTION — Review flagged findings with your team before granting tool access.${c.reset}`
    );
  } else {
    lines.push(
      `${c.bold}${c.red}VERDICT: DO NOT INSTALL — Untrusted execution patterns, symlink escapes, or hooks detected.${c.reset}`
    );
  }

  return lines.join('\n');
}

export function formatSkillAuditMarkdown(report: SkillAuditReport): string {
  const lines: string[] = [];
  lines.push(`# StealthMark Skill Audit Report`);
  lines.push(``);
  lines.push(`> Target: \`${report.targetPath}\`  `);
  lines.push(`> Scanned At: **${report.scannedAt}**  `);
  lines.push(`> Skills Detected: **${report.skillsCount}** | Files Scanned: **${report.filesScanned}**  `);
  lines.push(`> Risk Score: **${report.riskScore} / 100** — **${report.verdict}**  `);
  lines.push(
    `> Breakdown: **${report.summary.critical} Critical**, **${report.summary.high} High**, **${report.summary.medium} Medium**, **${report.summary.low} Low**`
  );
  lines.push(``);

  if (report.spectorBridge) {
    lines.push(`### Bridge Status`);
    lines.push(`- **SkillSpector**: ${report.spectorBridge.executed ? 'Executed' : report.spectorBridge.available ? 'Available (Skipped)' : 'Not installed'}`);
    if (typeof report.spectorBridge.score === 'number') {
      lines.push(`- **SkillSpector Risk Score**: ${report.spectorBridge.score}`);
    }
    if (typeof report.spectorBridge.issuesCount === 'number') {
      lines.push(`- **SkillSpector Issues Count**: ${report.spectorBridge.issuesCount}`);
    }
    lines.push(``);
  }

  lines.push(`## Findings`);
  lines.push(``);
  if (report.findings.length === 0) {
    lines.push(`No supply-chain anomalies, hooks, or rogue patterns detected.`);
  } else {
    lines.push(`| Severity | Rule ID | File | Line | Description | Source |`);
    lines.push(`| :--- | :--- | :--- | :---: | :--- | :--- |`);
    for (const f of report.findings) {
      const lineStr = f.line ? String(f.line) : '-';
      const descClean = f.description.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      lines.push(`| **${f.severity}** | \`${f.id}\` | \`${f.file}\` | ${lineStr} | ${descClean} | ${f.source || 'stealthmark'} |`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`*Generated by StealthMark Skill Audit v5.1 · Supply-Chain Defense Gate · https://stealthmark.io*`);

  return lines.join('\n');
}

export async function runSkillAudit(
  targetPath: string,
  options: SkillAuditOptions = {}
): Promise<SkillAuditResult> {
  const resolvedTarget = path.resolve(process.cwd(), targetPath);

  if (!fs.existsSync(resolvedTarget)) {
    const errorMsg = `Target path does not exist: ${resolvedTarget}`;
    const emptyReport: SkillAuditReport = {
      targetPath: resolvedTarget,
      scannedAt: new Date().toISOString(),
      skillsCount: 0,
      filesScanned: 0,
      riskScore: 100,
      verdict: 'DO NOT INSTALL',
      findings: [
        {
          id: 'PATH_NOT_FOUND',
          severity: 'CRITICAL',
          rule: 'Target path verification',
          file: targetPath,
          description: errorMsg,
          source: 'stealthmark',
        },
      ],
      summary: { critical: 1, high: 0, medium: 0, low: 0 },
    };
    return {
      success: false,
      targetPath: resolvedTarget,
      report: emptyReport,
      output: options.json
        ? JSON.stringify(emptyReport, null, 2)
        : options.markdown
        ? formatSkillAuditMarkdown(emptyReport)
        : formatSkillAuditTerminal(emptyReport, options.noColor),
      error: errorMsg,
    };
  }

  const stat = fs.statSync(resolvedTarget);
  const scanRoot = stat.isDirectory() ? resolvedTarget : path.dirname(resolvedTarget);
  const files = stat.isDirectory() ? collectFilesRecursively(resolvedTarget) : [resolvedTarget];

  const findings: SkillAuditFinding[] = [];
  let skillsCount = 0;

  // Pass 1: Deterministic Static Supply-Chain & Agent Safety Gate
  for (const fullPath of files) {
    const relPath = path.relative(scanRoot, fullPath) || path.basename(fullPath);
    const normalizedRel = relPath.replace(/\\/g, '/');
    const baseName = path.basename(fullPath).toLowerCase();

    // 1. Check symlink escape
    try {
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const resolvedRoot = fs.realpathSync(scanRoot);
          const relToRoot = path.relative(resolvedRoot, realTarget);
          if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
            findings.push({
              id: 'SYMLINK_ESCAPE',
              severity: 'CRITICAL',
              rule: 'Symlink points outside skill root directory',
              file: relPath,
              description: `Symbolic link ${relPath} escapes skill root -> points to external target: ${realTarget}`,
              source: 'stealthmark',
            });
          }
        } catch {
          findings.push({
            id: 'SYMLINK_ESCAPE',
            severity: 'CRITICAL',
            rule: 'Cyclical or broken symlink',
            file: relPath,
            description: `Symbolic link ${relPath} is cyclical, points to non-existent target, or fails to resolve.`,
            source: 'stealthmark',
          });
        }
        // Skip scanning content of symlinks that escape or break
        continue;
      }
    } catch {
      continue;
    }

    // 2. CONFIG_HIJACK (CRITICAL): bundled .mcp.json or hooks.json
    if (CONFIG_HIJACK_FILES.has(baseName)) {
      findings.push({
        id: 'CONFIG_HIJACK',
        severity: 'CRITICAL',
        rule: 'Bundled auto-executing configuration file',
        file: relPath,
        description: `Bundled ${baseName} detected. Agent configuration files hijack host runtime execution.`,
        source: 'stealthmark',
      });
    }

    // 3. VENDOR_BLOAT (HIGH): bundled node_modules/
    if (normalizedRel.startsWith('node_modules/') || normalizedRel.includes('/node_modules/')) {
      findings.push({
        id: 'VENDOR_BLOAT',
        severity: 'HIGH',
        rule: 'Bundled third-party dependency vendor bloat',
        file: relPath,
        description: `Bundled node_modules directory detected at ${relPath}.`,
        source: 'stealthmark',
      });
    }

    // Check file stats
    let fileStat: fs.Stats;
    try {
      fileStat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    // 4. VENDOR_BLOAT (HIGH): files > 1 MB
    if (fileStat.size > MAX_SCAN_BYTES) {
      findings.push({
        id: 'VENDOR_BLOAT',
        severity: 'HIGH',
        rule: 'Oversized file artifact (> 1 MB)',
        file: relPath,
        description: `File size (${(fileStat.size / (1024 * 1024)).toFixed(2)} MB) exceeds 1 MB supply-chain threshold.`,
        source: 'stealthmark',
      });
      continue;
    }

    // 5. BYTECODE_OR_BINARY (HIGH): .pyc, .pyo, .so, .dylib, .dll, .wasm
    const ext = path.extname(fullPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      findings.push({
        id: 'BYTECODE_OR_BINARY',
        severity: 'HIGH',
        rule: 'Compiled bytecode or native binary artifact',
        file: relPath,
        description: `Precompiled binary or bytecode extension "${ext}" detected: ${relPath}.`,
        source: 'stealthmark',
      });
      continue;
    }

    // Check executable bits outside scripts/
    const isExecutable = (fileStat.mode & 0o111) !== 0;
    const isInsideScripts = normalizedRel.startsWith('scripts/') || normalizedRel.includes('/scripts/');
    if (isExecutable && !isInsideScripts && !baseName.endsWith('.sh') && !baseName.endsWith('.py')) {
      findings.push({
        id: 'BYTECODE_OR_BINARY',
        severity: 'HIGH',
        rule: 'Executable bits outside scripts/ directory',
        file: relPath,
        description: `File ${relPath} has executable bits (chmod +x) outside scripts/ directory.`,
        source: 'stealthmark',
      });
    }

    // Read file bytes for null-byte check & content inspection
    let rawBuffer: Buffer;
    try {
      rawBuffer = fs.readFileSync(fullPath);
    } catch {
      continue;
    }

    if (isBinaryBuffer(rawBuffer)) {
      findings.push({
        id: 'BYTECODE_OR_BINARY',
        severity: 'HIGH',
        rule: 'Null-byte binary payload',
        file: relPath,
        description: `File contains raw null bytes, indicating binary or compiled content: ${relPath}.`,
        source: 'stealthmark',
      });
      continue;
    }

    const textContent = rawBuffer.toString('utf8');

    // 6. HOOK_INJECTION (CRITICAL): frontmatter YAML in SKILL.md defines hooks:
    if (baseName === 'skill.md') {
      skillsCount++;
      const fmMatch = textContent.match(FRONTMATTER_RE);
      if (fmMatch && fmMatch[1]) {
        const frontmatter = fmMatch[1];
        if (HOOKS_RE.test(frontmatter)) {
          findings.push({
            id: 'HOOK_INJECTION',
            severity: 'CRITICAL',
            rule: 'Frontmatter unauthorized hooks definition',
            file: relPath,
            description:
              'Frontmatter YAML in SKILL.md declares hooks:, enabling arbitrary command execution on agent trigger.',
            source: 'stealthmark',
          });
        }
      }
    }

    // 7. Check line-by-line content patterns (PIPE_TO_SHELL, CREDENTIAL_OR_IMDS_ACCESS, AGENT_CONFIG_SNOOPING, UNATTENDED_INSTALL)
    const lines = textContent.split(/\r?\n/);
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';
      for (const pat of CONTENT_PATTERNS) {
        const match = line.match(pat.regex);
        if (match) {
          findings.push({
            id: pat.id,
            severity: pat.severity,
            rule: pat.rule,
            file: relPath,
            line: lineIdx + 1,
            description: pat.describe(match[0]),
            source: 'stealthmark',
          });
        }
      }
    }
  }

  // Pass 2: Optional SkillSpector Bridge
  const binary = resolveSkillSpectorBinary();
  let spectorBridge: SkillAuditReport['spectorBridge'] = {
    available: Boolean(binary),
    executed: false,
  };

  const shouldRunSpector = !options.noSpector && (options.spector || Boolean(binary));
  if (shouldRunSpector && binary) {
    const tmpJson = path.join(os.tmpdir(), `skillspector-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      child_process.execFileSync(
        binary,
        ['scan', scanRoot, '--no-llm', '--format', 'json', '--output', tmpJson],
        {
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        }
      );

      if (fs.existsSync(tmpJson)) {
        const rawJson = fs.readFileSync(tmpJson, 'utf8');
        const parsed = JSON.parse(rawJson);
        const issues = Array.isArray(parsed.issues) ? parsed.issues : [];

        spectorBridge = {
          available: true,
          executed: true,
          score: typeof parsed.risk_score === 'number' ? parsed.risk_score : undefined,
          issuesCount: issues.length,
        };

        for (const issue of issues) {
          if (!issue || typeof issue !== 'object') continue;
          const loc = issue.location && typeof issue.location === 'object' ? issue.location : {};
          const sev = mapSpectorSeverity(issue.severity);
          findings.push({
            id: String(issue.pattern || issue.category || 'SKILLSPECTOR_ALERT'),
            severity: sev,
            rule: String(issue.category || 'SkillSpector Static Analysis'),
            file: String(loc.file || 'SKILL.md'),
            line: typeof loc.start_line === 'number' ? loc.start_line : undefined,
            description: `[SkillSpector] ${String(issue.description || issue.pattern || 'Pattern flagged')}`,
            source: 'skillspector',
          });
        }

        try {
          fs.unlinkSync(tmpJson);
        } catch {
          // ignore cleanup error
        }
      }
    } catch (err: unknown) {
      spectorBridge = {
        available: true,
        executed: false,
        error: err instanceof Error ? err.message : String(err),
      };
      if (fs.existsSync(tmpJson)) {
        try {
          fs.unlinkSync(tmpJson);
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  // Deduplicate findings
  const seenKeys = new Set<string>();
  const dedupedFindings: SkillAuditFinding[] = [];
  for (const f of findings) {
    const key = `${f.id}:${f.severity}:${f.file}:${f.line ?? 0}:${f.description}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedFindings.push(f);
    }
  }

  const { score, verdict, summary } = calculateRiskScore(dedupedFindings);

  const report: SkillAuditReport = {
    targetPath: resolvedTarget,
    scannedAt: new Date().toISOString(),
    skillsCount: Math.max(skillsCount, 1),
    filesScanned: files.length,
    riskScore: score,
    verdict,
    findings: dedupedFindings,
    summary,
    spectorBridge,
  };

  const output = options.json
    ? JSON.stringify(report, null, 2)
    : options.markdown
    ? formatSkillAuditMarkdown(report)
    : formatSkillAuditTerminal(report, options.noColor);

  return {
    success: verdict === 'SAFE',
    targetPath: resolvedTarget,
    report,
    output,
  };
}
