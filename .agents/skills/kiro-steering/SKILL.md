---
name: kiro-steering
description: Maintain .kiro/steering/ when bootstrapping project guidance or
  synchronizing it with code and confirmed decisions.
metadata:
  shared-rules: steering-principles.md
---

# Maintain project steering

Keep `.kiro/steering/` aligned with the project's intended architecture and current code. Steering records durable conventions and decision context, not feature inventories or a second copy of `package.json`.

Read [steering principles](rules/steering-principles.md). Reuse context already loaded; inspect the code and configuration needed to verify mutable claims.

## Bootstrap

When core files (`product.md`, `tech.md`, `structure.md`) are missing, use the matching templates in `.kiro/settings/templates/steering/` as prompts for research. Preserve existing files; create only what is missing. Extract product purpose, architectural choices, and organization patterns from the actual repository. Independent research may run in parallel when useful.

## Synchronize

For a requested audit, inspect all steering; for a domain update, inspect that domain and related cross-cutting rules. Compare claims against their live sources. Correct stale statements, remove supported duplication, and preserve valid user decisions and examples. Distinguish an outdated description from code that violates an intended rule; do not silently redefine the rule to match a defect.

Apply updates when the request authorizes them; an assessment-only request ends with findings. Ask only when an unresolved contradiction materially changes the intended policy. Routine wording, broken pointers, and proven stale facts do not need separate approval.

## Completion

Each changed claim has source evidence, each reference resolves, and no known contradiction remains in the audited scope. Summarize files changed, meaningful drift, and unresolved decisions. A new on-demand file needs a task-specific pointer in the root instructions; it is not automatically loaded merely because it lives in `.kiro/steering/`.
