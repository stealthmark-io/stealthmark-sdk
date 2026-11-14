// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — Public Library Exports
// ═══════════════════════════════════════════════════════════════════

export { runInit, detectFramework, type Framework, type InitOptions, type InitResult } from './commands/init.js';
export { runVerify, type VerificationCheck, type VerificationReport } from './commands/verify.js';
export {
  runAudit,
  normalizeTargetDomain,
  formatTerminalReport,
  formatMarkdownReport,
  type AuditCheckItem,
  type SectionCounts,
  type AuditSummary,
  type AuditReport,
  type AuditOptions,
  type AuditResult,
} from './commands/audit.js';
export {
  runSkillAudit,
  formatSkillAuditTerminal,
  formatSkillAuditMarkdown,
  type SkillSeverity,
  type SkillAuditFinding,
  type SkillAuditReport,
  type SkillAuditOptions,
  type SkillAuditResult,
} from './commands/skill-audit.js';
