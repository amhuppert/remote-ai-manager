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
 * four modules that used to own divergent copies of terminality, slot
 * ownership, archive eligibility, and replacement now read them from the one
 * contract module and declare none of their own.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

const CONTRACT_MODULE = "src/lib/workflow-graph/lifecycle-classifier.ts";

const CONSUMERS = [
  "src/lib/workflow-graph/workflow-manager.ts",
  "src/lib/workflow-graph/execution-repository.ts",
  "src/lib/workflow-graph/execution-route-handlers.ts",
  "src/lib/validation/singleton.ts",
] as const;

/**
 * The decisions the contract owns. A consumer that declares any of these names
 * itself — or rebuilds one as a local status allowlist — has forked the policy,
 * which is the exact defect this contract exists to prevent.
 */
const CONTRACT_DECISIONS = [
  "isTerminalStatus",
  "autoReleasesSlot",
  "retainsSlotOwnership",
  "explicitArchiveEligibility",
  "replacementPolicy",
  "graphWorkflowLifecycleDecision",
] as const;

const LOCAL_STATUS_ALLOWLISTS = [
  "terminalStatuses",
  "replaceableStatuses",
  "autoReleaseStatuses",
  "archivableStatuses",
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

  for (const consumer of CONSUMERS) {
    const source = read(consumer);

    it(`${consumer} imports the lifecycle contract`, () => {
      expect(source).toMatch(
        /from "(@\/lib\/workflow-graph\/|\.\/)lifecycle-classifier"/,
      );
    });

    it(`${consumer} declares no local copy of a contract decision`, () => {
      for (const decision of CONTRACT_DECISIONS) {
        expect(source).not.toContain(`function ${decision}(`);
        expect(source).not.toContain(`const ${decision} =`);
      }
    });

    it(`${consumer} rebuilds no local status allowlist`, () => {
      for (const name of LOCAL_STATUS_ALLOWLISTS) {
        expect(source).not.toContain(name);
      }
    });
  }
});
