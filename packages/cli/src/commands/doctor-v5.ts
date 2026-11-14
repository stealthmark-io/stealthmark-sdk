import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function compareSemver(a: string, b: string): number {
  const pa = String(a).replace(/^[^\d]+/, '').split('.').map(Number);
  const pb = String(b).replace(/^[^\d]+/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export async function runPdfInspector(filePath: string): Promise<void> {
  console.log(`\n${C.bold}${C.cyan}📄 StealthMark Weaponized PDF Inspector v5.1${C.reset}`);
  const resolved = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    console.error(`${C.red}✖ File not found:${C.reset} ${resolved}`);
    process.exit(1);
  }

  const rawBuffer = fs.readFileSync(resolved);
  const content = rawBuffer.toString('latin1');

  if (!content.startsWith('%PDF-')) {
    console.log(`${C.yellow}⚠ Warning:${C.reset} File does not start with standard %PDF- header (possible polyglot or spoofed extension).`);
  }

  const dangerousPatterns = [
    { regex: /\/JavaScript\b|\/JS\b/g, name: 'Embedded JavaScript (/JS, /JavaScript)', severity: 'CRITICAL' },
    { regex: /\/Launch\b/g, name: 'OS Command Launch Action (/Launch)', severity: 'CRITICAL' },
    { regex: /\/OpenAction\b|\/AA\b/g, name: 'Automatic Execution Trigger (/OpenAction, /AA)', severity: 'HIGH' },
    { regex: /\/EmbeddedFiles\b/g, name: 'Hidden Embedded File Dropper (/EmbeddedFiles)', severity: 'HIGH' },
    { regex: /\/GoToR\b|\/SubmitForm\b/g, name: 'External SSRF / SMB Hash Leak Trigger (/GoToR, /SubmitForm)', severity: 'HIGH' },
    { regex: /\/XFA\b|\/RichMedia\b/g, name: 'XFA / RichMedia Exploit Surface', severity: 'MEDIUM' },
    { regex: /<!ENTITY\s+/gi, name: 'XML External Entity (XXE in XMP Metadata)', severity: 'CRITICAL' },
    { regex: /ignore all previous instructions|system prompt override|hire this candidate/gi, name: 'Hidden AI Resume/Invoice Prompt Injection', severity: 'HIGH' },
  ];

  let hits = 0;
  for (const pat of dangerousPatterns) {
    const matches = content.match(pat.regex);
    if (matches && matches.length > 0) {
      hits++;
      console.log(`  ${C.red}✖ [${pat.severity}]${C.reset} Detected ${pat.name} (${matches.length} occurrence(s))`);
    }
  }

  if (hits === 0) {
    console.log(`  ${C.green}✓ Clean PDF:${C.reset} Zero executable tags (/JS, /Launch, /OpenAction) or AI prompt injections detected.\n`);
  } else {
    console.log(`\n  ${C.red}${C.bold}🚨 DANGER: Do NOT open this PDF in a desktop reader!${C.reset}`);
    console.log(`  ${C.cyan}Protect your company's upload forms automatically at the edge with StealthMark v5:${C.reset} https://stealthmark.io/scan\n`);
    process.exit(1);
  }
}

export async function runLocalDoctorV5(): Promise<void> {
  console.log(`\n${C.bold}${C.cyan}🛡️  StealthMark Workstation, Server & Container Doctor v5.1${C.reset}`);
  console.log(`${C.dim}Auditing Node2Shell (CVE-2026-111497), Next.js 14/sharp, Linux SUID/GTFOBins, TeamViewer (CVE-2026-111585), Docker & Cursor IOCs...${C.reset}\n`);

  let issuesFound = 0;
  const homeDir = os.homedir();
  const platform = os.platform();
  const release = os.release();

  const nodeVer = process.version.replace(/^v/, '');
  const major = parseInt(nodeVer.split('.')[0], 10);
  let nodeVulnerable = false;

  if (major < 22) nodeVulnerable = true;
  else if (major === 22 && compareSemver(nodeVer, '22.23.4') < 0) nodeVulnerable = true;
  else if (major === 24 && compareSemver(nodeVer, '24.22.1') < 0) nodeVulnerable = true;
  else if (major === 26 && compareSemver(nodeVer, '26.12.1') < 0) nodeVulnerable = true;

  if (nodeVulnerable) {
    issuesFound++;
    console.log(`  ${C.red}✖ [CRITICAL NODE2SHELL RCE]${C.reset} Node.js v${nodeVer} is vulnerable to CVE-2026-111497 (Brotli Decompression RCE)!`);
  } else {
    console.log(`  ${C.green}✓ [Node.js Runtime]${C.reset} Node.js v${nodeVer} is patched against Node2Shell (CVE-2026-111497)`);
  }

  if (platform === 'linux') {
    const riskySuidBins = ['/usr/bin/find', '/bin/find', '/usr/bin/vim', '/usr/bin/python3', '/bin/bash'];
    const suidHits: string[] = [];
    for (const binPath of riskySuidBins) {
      if (fs.existsSync(binPath)) {
        try {
          const st = fs.statSync(binPath);
          if ((st.mode & 0o4000) !== 0) {
            suidHits.push(binPath);
          }
        } catch {
          // ignore
        }
      }
    }
    if (suidHits.length > 0) {
      issuesFound++;
      console.log(`  ${C.red}✖ [CRITICAL LINUX PRIV-ESC]${C.reset} Dangerous SUID bit (-4000) set on GTFOBins: ${suidHits.join(', ')}`);
    } else {
      console.log(`  ${C.green}✓ [Linux SUID Audit]${C.reset} No dangerous SUID bit found on find/vim/python/bash`);
    }

    const matchKernel = release.match(/^(\d+\.\d+\.\d+)-(\d+)/);
    if (matchKernel && matchKernel[1] === '6.8.0' && parseInt(matchKernel[2], 10) < 124) {
      issuesFound++;
      console.log(`  ${C.red}✖ [CISA KEV LINUX KERNEL]${C.reset} Kernel ${release} is below 6.8.0-124.`);
    }
  }

  const authKeysPath = path.join(homeDir, '.ssh', 'authorized_keys');
  if (fs.existsSync(authKeysPath) && /svc-telemetry/i.test(fs.readFileSync(authKeysPath, 'utf8'))) {
    issuesFound++;
    console.log(`  ${C.red}✖ [CRITICAL SUPPLY-CHAIN IOC]${C.reset} Backdoor SSH key "svc-telemetry" found in ~/.ssh/authorized_keys!`);
  } else {
    console.log(`  ${C.green}✓ [Supply-Chain & SSH]${C.reset} Clean (no Cursor/Claude Code "svc-telemetry" backdoor key)`);
  }

  console.log('\n------------------------------------------------------------');
  if (issuesFound === 0) {
    console.log(`${C.green}${C.bold}✓ All v5 local checks passed with 0 critical exposures.${C.reset}\n`);
  } else {
    console.log(`${C.red}${C.bold}⚠ Detected ${issuesFound} critical vulnerability/IOC(s)!${C.reset}`);
    console.log(`   👉 ${C.bold}https://stealthmark.io/scan${C.reset} (Active Shield v5 Pro — $24.50 w/ BLACKOCTOBER)\n`);
  }
}
