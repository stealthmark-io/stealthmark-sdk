# AGENTS.md — `@stealthmark` Open-Source SDK

## 3-Judge Clean-Context Jury Gate (Pre-Commit / Bugs / Security / Releases)
Before closing or proposing any non-trivial code/config update, `git commit`, `git push`, npm release, bug validation/fix, security/supply-chain change (`SkillSpector`, `skill-audit`, token/input sanitization, CSP/headers), or public SDK contract change across `packages/*`, run `npm run typecheck && npm test` and invoke a **3-judge clean-context Jury** (the most capable model available, read-only):
1. **Technical & Parity Judge**: correctness, strict TypeScript types, edge cases, byte-for-byte parity where applicable, and post-edit tests.
2. **Security & OPSEC Judge**: zero secrets/private metadata, safe subprocess/network boundaries, input validation, strict open-source hygiene.
3. **Product, UX, Zero-Humo & Code Quality Judge**: honest README/docs parity, surgical diffs, zero slop.

- Output format: `VEREDICTO: APROBADO | APROBADO CON CORRECCIONES | NO APROBADO` (`VETO` / Critical / High / Blocking / Medium / Low). Resolve every `VETO` / Critical / High / Blocking finding and **re-run `npm run typecheck && npm test` after the final edit** before shipping or committing.
- Any `NO APROBADO` blocks. A `VETO` or Critical always goes back to the judge who raised it for one re-check of the fix; other findings need that re-check only when the fix touches architecture, auth/perimeter, critical arithmetic, public SDK contracts or the security surface. Verify live only your own services in local or staging. No `VEREDICTO` is approval: commit, push, release and deploy still need the maintainer's explicit go-ahead.
- Exception: pure read-only queries and trivial typos with zero technical, operational, compliance, or security impact. Fallback without subagents: `code-review-and-quality` (or `thermo-nuclear-review` + `thermo-nuclear-code-quality-review`) + `security` as separate passes, labeled "fallback review (not a jury)", with no `VEREDICTO` line.

## Verification Command
```zsh
npm run typecheck && npm test
```
*(Run from repository root so only workspace packages execute; avoid bare `vitest` at root if local worktrees exist.)*
