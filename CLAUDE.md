# Claude Code

@AGENTS.md

This file adds only Claude Code-specific workflow and tool routing. The shared engineering contract lives in `AGENTS.md`.

## Kiro workflow

- Start spec-driven work with `/kiro-spec-status <feature>`.
- For a new feature, use `/kiro-spec-init`, `/kiro-spec-requirements`, `/kiro-spec-design`, and `/kiro-spec-tasks` in order; do not bypass the human approval between stages unless Alex explicitly requests the fast path.
- Implement approved tasks with `/kiro-impl`; use `/kiro-validate-impl`, `/kiro-review`, or `/kiro-verify-completion` for evidence-based verification.
- Use `/kiro-discovery` when scope is unclear and `/kiro-spec-quick` only for an intentional single-spec fast path.

## Claude-specific skill routing

- For browser-driven UI verification, run `cctl dev ensure`, then use `.claude/skills/playwright-cli/SKILL.md`. Use `.agents/skills/nextjs-mcp/SKILL.md` for Next.js runtime/build diagnostics or Chrome DevTools-only profiling.
- Use `/ui-design` for feature UI and `/ui-primitive` for reusable primitives. Both are design-first; obtain approval for the proposed interaction/API before implementation.
- UI work follows `.claude/skills/cc-design-system/SKILL.md` and `docs/tailwind-conventions.md`.

Read only the task-relevant steering documents listed in `AGENTS.md`; do not load the whole steering directory into every turn.
