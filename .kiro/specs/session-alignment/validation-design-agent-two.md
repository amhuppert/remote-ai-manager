# Design Review Summary

The session-alignment design is thorough and generally aligned with the existing Command Center architecture: it uses a dedicated authoritative domain, reuses existing command/UI/runtime seams, and correctly treats runtime propagation as the load-bearing risk. I would not approve it for task generation yet because the migration contract and charter activation topology still conflict with approved requirements in ways that can change persisted session state or bypass the intended human gates.

# Critical Issues

🔴 **Critical Issue 1**: Migration maps historical `focus` sessions to `normal`
**Concern**: The design's migration updates `creation_mode IN ('fast','focus')` to `normal`, even though the requirements allow only `fast` → `normal` and explicitly say there is no focus-session migration.
**Impact**: This changes session data beyond the permitted migration scope, can surface old focus sessions as normal sessions, and effectively introduces backward compatibility that requires Alex's explicit approval.
**Suggestion**: Change `0004-fast-to-normal` to map only `creation_mode = 'fast'`; separately specify the intended handling for existing `focus` rows as deletion/quarantine or get explicit approval for preserving them as `normal`.
**Traceability**: R1.4, R1.5, R1.7; Migration scope.
**Evidence**: `design.md` Modified Files (`0004-fast-to-normal.ts`), Testing Strategy (`Migration 0004`), and Migration Strategy (`UPDATE creation_mode IN fast focus to normal`, "Defensively also maps any lingering focus value").

🔴 **Critical Issue 2**: Approved-decision auto-activation can degrade into a separate charter approval or lose audit linkage
**Concern**: The design says a decision draft can be replaced by a newer draft, leaving linked decisions "unresolved-by-version," and says losing the `auto_activate` marker degrades to a manual Approve-Charter banner.
**Impact**: Approved decisions may fail R6.2's requirement to link to the charter version they produced, and a manual Approve-Charter fallback violates R5.5/R11 because decision approval is supposed to be the only gate for that charter update.
**Suggestion**: Persist decision-incorporation intent transactionally and make it non-degrading: after a user approves decisions, the resulting `write_session_charter` must either auto-activate and set `produced_version` or remain pending/retryable, never become a manual charter approval and never orphan linked decisions.
**Traceability**: R5.4, R5.5, R6.2, R11.1-R11.3.
**Evidence**: `design.md` decision flow (`auto_activate=true -> activate, set decisions.produced_version`), State Management concurrency note, Implementation Notes risk, and `AlignmentDecision.producedVersion`.

🔴 **Critical Issue 3**: Rollback activation path is inconsistent with the two-gate topology
**Concern**: The design exposes `POST rollback`, `service.rollback`, `source: "rollback"`, and a test where rollback creates a new active version, while also stating that only `approveDraft` and `resolveProposals` activate a charter and no other path mutates the active charter.
**Impact**: Implementers have conflicting instructions and may add a third activation path outside the approved gate model, undermining R11 and the audit semantics of charter changes.
**Suggestion**: Define rollback explicitly before task generation: either rollback creates a draft that uses the existing Approve Charter gate, or the requirements/design must name direct rollback as an allowed non-gate activation path. Then update service invariants, API routes, and tests to match one model.
**Traceability**: R8.5, R11.1, R11.2.
**Evidence**: `design.md` File Structure Plan (`rollback/route.ts`), Service Interface (`rollback(input)`), Responsibilities & Constraints ("Only two methods activate"), Data Model (`source = rollback`), Testing Strategy (`rollback creates a new active version`).

# Design Strengths

- The runtime propagation design is well-justified. Version-gated runtime recreation directly addresses the verified Claude/Codex asymmetry and includes the right load-bearing regression test.
- The dedicated `src/lib/session-alignment/` authority with DocsPanel/reference-document reuse is the right architectural split: app state owns governance while existing UI/discovery surfaces remain reused rather than forked.

# Final Assessment

**Decision: NO-GO.** The design has a solid architecture, but the unresolved migration and activation-topology conflicts are requirement-level issues, not implementation details. Revise the focus-row migration, make decision-approved incorporation durable without a manual approval fallback, and settle rollback semantics against R11 before running `$kiro-validate-design session-alignment` again or generating tasks.

# Interactive Discussion

The main choice that needs Alex's decision is the handling of existing `focus` rows. The requirements currently read as "do not migrate them"; preserving them as `normal` may be defensible operationally, but it is a requirement change/backward-compatibility choice and should be approved explicitly rather than buried in the migration.
