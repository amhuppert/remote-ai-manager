import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard over the ENUMERATED consumers of the lifecycle contract (design §10).
 *
 * Deliberately a closed list, not a repository-wide sweep: an unbounded "no
 * file anywhere restates a status rule" claim cannot be kept honest (the
 * transition tables in workflow-manager legitimately enumerate statuses for a
 * different decision — which transitions are legal). What this pins is that the
 * modules that used to own divergent copies of terminality, slot ownership,
 * archive eligibility, and replacement now read them from the one contract
 * module and declare none of their own.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

const CONTRACT_MODULE = "src/lib/workflow-graph/lifecycle-classifier.ts";

const CONSUMERS = [
  "src/lib/workflow-graph/workflow-manager.ts",
  // D7: the AUTHORITATIVE launch admission runs inside the serialized
  // reservation here, so the setter is a first-class contract consumer — the
  // decision that installs or refuses an execution must be the same one the
  // manager's advisory guard read.
  "src/lib/state-store/setters.ts",
  "src/lib/workflow-graph/execution-route-handlers.ts",
  "src/lib/validation/singleton.ts",
  // D7: the ambient Needs-Input feed. Its approval-gate standing kept a private
  // status set, which is why a non-resumably halted or abandoned gate went on
  // advertising a decision nobody could act on.
  "src/lib/active-conversations/route-handlers.ts",
  // D7: the four remaining private copies of the same question — "is this gate
  // or park still live work". Three of them carried a "keep in sync" comment
  // pointing at the feed above, which is precisely the arrangement that drifts:
  // the browser went on rendering a gate the server had already dropped, and
  // chat stayed open on a run that could never apply the decision.
  "src/features/session/hooks/use-approval-gate.ts",
  "src/hooks/use-user-input-gate.ts",
  "src/lib/workflow-graph/approval-gate.ts",
  "src/lib/prompt/route-handlers.ts",
  // D7 R12.4: the session card is an ambient indicator, and the active-execution
  // query hands it the row that physically occupies the active position — which
  // a lease-free run is allowed to keep until the next launch normalizes it away.
  // Rendering on presence made every historical run look Current.
  "src/features/session/conversation/GraphWorkflowCard.tsx",
] as const;

/**
 * The SQL-side ambient projection. It cannot import the contract — it is a
 * correlated subquery — so it reads `lease_held`, the derived column the
 * executions repository writes from `holdsExecutionLease` on every `setActive`.
 * Pinned separately because a status list in SQL is invisible to every
 * TypeScript-level guard above, which is how this one survived.
 */
const SQL_LEASE_PROJECTION = "src/lib/state-store/sessions-repo.ts";

/**
 * Modules that used to own a divergent copy and now DELEGATE rather than
 * decide. They must still declare no local rule, but they legitimately no
 * longer import the contract: `execution-repository.ts` hands its launch to
 * `reserveActiveGraphWorkflowExecution`, which owns the admission, so requiring
 * an import here would force a decorative one.
 */
const DELEGATING_MODULES = [
  "src/lib/workflow-graph/execution-repository.ts",
] as const;

/**
 * The decisions the contract owns. A consumer that declares any of these names
 * itself — or rebuilds one as a local status allowlist — has forked the policy,
 * which is the exact defect this contract exists to prevent.
 */
const CONTRACT_DECISIONS = [
  "isTerminalStatus",
  "graphWorkflowLifecycleDecision",
  // D7: the lease and the admission decision it feeds join the contract, and
  // they replace the status-only tenure rules below.
  "holdsExecutionLease",
  "evaluateLeaseAdmission",
  // D7 decision D17: "is this run parked awaiting a definition decision" now
  // decides the lease remedy AND editability, so a per-surface copy would let
  // one surface freeze the parked snapshot while another kept editing it.
  "awaitsDefinitionApproval",
] as const;

/**
 * Status-only approximations of tenure that D7 retires (decision D3). A status
 * set cannot see halt resumability or abandonment, so anything reconstructing
 * one — under the old exported names or as a local allowlist — has forked the
 * lease away from `holdsExecutionLease`.
 */
const RETIRED_TENURE_RULES = [
  "autoReleasesSlot",
  "retainsSlotOwnership",
  "replacementPolicy",
  "slotOwnership",
  "audited-archive",
  // D7 decision D5: with CLEAR and `workflow live release` deleted, the
  // status-only archive-eligibility rule had nothing left to gate — a run may
  // be relocated into History exactly when it no longer holds the lease.
  "explicitArchiveEligibility",
];

const LOCAL_STATUS_ALLOWLISTS = [
  "terminalStatuses",
  "replaceableStatuses",
  "autoReleaseStatuses",
  "archivableStatuses",
  "leaseStatuses",
];

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

describe("lifecycle contract consumers", () => {
  const contractSource = read(CONTRACT_MODULE);

  it("declares every contract decision in exactly one module", () => {
    for (const decision of CONTRACT_DECISIONS) {
      expect(contractSource).toContain(`export function ${decision}(`);
    }
  });

  it("keeps no retired status-only tenure rule anywhere in the contract", () => {
    for (const retired of RETIRED_TENURE_RULES) {
      expect(contractSource).not.toContain(retired);
    }
  });

  for (const consumer of CONSUMERS) {
    const source = read(consumer);

    it(`${consumer} imports the lifecycle contract`, () => {
      expect(source).toMatch(
        /from "(@\/lib\/workflow-graph\/|\.\/)lifecycle-classifier"/,
      );
    });
  }

  for (const consumer of [...CONSUMERS, ...DELEGATING_MODULES]) {
    const source = read(consumer);

    it(`${consumer} declares no local copy of a contract decision`, () => {
      for (const decision of CONTRACT_DECISIONS) {
        expect(source).not.toContain(`function ${decision}(`);
        expect(source).not.toContain(`const ${decision} =`);
      }
    });

    it(`${consumer} consumes no retired status-only tenure rule`, () => {
      for (const retired of RETIRED_TENURE_RULES) {
        expect(source).not.toContain(retired);
      }
    });

    it(`${consumer} rebuilds no local status allowlist`, () => {
      for (const name of LOCAL_STATUS_ALLOWLISTS) {
        expect(source).not.toContain(name);
      }
    });

    /**
     * Structural, not name-based: the allowlist check above only catches the
     * names it already knows, and the gate-standing set that shipped this defect
     * was called something else entirely. A set OF statuses is the shape of the
     * mistake, whatever it is named.
     *
     * Enumerating statuses is not banned outright — the manager's transition
     * tables legitimately do it, for a different decision (which transitions are
     * legal). Collecting them into a membership set is what stands in for
     * tenure, so that is what this pins.
     */
    it(`${consumer} builds no status membership set`, () => {
      expect(source).not.toMatch(/(?:Readonly)?Set<\s*GraphWorkflowStatus\s*>/);
    });
  }

  describe(SQL_LEASE_PROJECTION, () => {
    const source = read(SQL_LEASE_PROJECTION);
    const AMBIENT_ALIAS = "AS has_active_graph_workflow";

    it("derives the ambient signal from the lease projection column", () => {
      const subqueries = source
        .split(AMBIENT_ALIAS)
        .slice(0, -1)
        .map((chunk) => chunk.slice(-400));
      expect(subqueries.length).toBeGreaterThan(0);
      for (const subquery of subqueries) {
        expect(subquery).toContain("lease_held");
        // The list this replaces named statuses this domain does not even have,
        // so `aborted` counted as live work on every session list.
        expect(subquery).not.toContain("e.status");
      }
    });
  });
});
