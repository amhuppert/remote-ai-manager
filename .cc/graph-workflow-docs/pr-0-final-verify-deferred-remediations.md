# PR-0 Final-Verify: Deferred Remediations

PR-0 of the codebase reorganization is **documentation only** per
`memory-bank/codebase-reorganization-implementation-plan.md`:

> ### PR-0 — Steering update
> **Scope:** documentation only. No code moves.
> **Files modified:**
> - `.kiro/steering/structure.md` — replace body with the content in the "Steering Update Specification" section above.
> **Verification:** typecheck/test/lint/build unchanged. `git diff` shows only the steering file change.

PR-0's final-verification context still ran the full end-of-reorg invariant
suite. Two invariants failed (real violations), but executing the remediations
in PR-0 would expand its diff far beyond the single steering file and violate
PR-0's verification criterion. Both are deferred to the appropriate later PR.

## Deferred #1 — `src/lib/*.ts` flat files (109)

**Detected by:** `git ls-files 'src/lib/*.ts' | awk -F/ 'NF==3'` (109 results,
snapshot at commit `6aa7399a`).

**Why deferred:** moving 109 files into 30+ new domain folders would expand
scope into "new domains" — the acceptance criterion explicitly forbids this in
a context-local remediation. The flat-file moves belong in the per-domain PRs
that follow PR-0 (each PR moves its own domain's files).

**File list:** see remediation task `remediate-lib-flat-files` for the full
enumeration.

**Recommended owner PR:** distribute across the per-domain PRs in the roadmap
(PR-1 through PR-N). Do NOT attempt as a single mega-PR.

## Deferred #2 — Cross-feature import: project-detail → session

**Detected by:** `git grep "from \"@/features/session" src/features/project-detail/`.

**Violation:** `src/features/project-detail/components/CreateSessionModal.tsx:13`
imports `ImageAttachmentPreview` from `@/features/session/prompt/ImageAttachmentPreview`.

**Why deferred:** even though small, it is a code move in a documentation-only
PR. Belongs in either the session-feature split PR or a dedicated
shared-component promotion PR.

**Fix recipe:**
1. `git mv src/features/session/prompt/ImageAttachmentPreview.tsx src/components/ImageAttachmentPreview.tsx`
2. Move colocated CSS/tests alongside.
3. Update both importers (`CreateSessionModal.tsx:13` + the original session-feature
   site found via `git grep`).
4. Run typecheck/lint/test/build.

## Recommendation for the workflow author

The final-verification context's invariants describe end-of-reorganization
state. Running it against PR-0 is informative (we now know what's left) but the
remediation tasks it auto-generates cannot be honored without breaking PR-0's
scope contract. Consider:

- Moving the full final-verify context to the LAST PR in the roadmap; or
- Splitting it into a per-PR "scope verification" (checks only what the current
  PR touched) and a final end-of-reorg verification.
