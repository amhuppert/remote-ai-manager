import { describe, expect, it } from "vitest";

import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { applyLiveExecutionEdits } from "@/lib/workflow-graph/runtime-edits";
import {
  computeLaneReminders,
  MAX_REMINDERS,
} from "@/lib/workflow-graph/lane-reminders";

import { nextAbandonCleanupStep } from "./abandon-coordinator";
import {
  prematureStartRefusal,
  reapprovalRefusal,
} from "./delivery-plan-service";
import { danglingReferenceRefusal } from "./element-write-guard";
import {
  notRunningCaptureRefusal,
  prelaunchRedirectRefusal,
} from "./execution-service";
import {
  dismissSupersededHumanActRefusal,
  dismissSupersededIneligibleRefusal,
  strandedProposalSignOffRefusal,
} from "./proposal-integrity";
import {
  specDeliveryPlanAttemptRowSchema,
  specExecutionRowSchema,
  specRevisionSchema,
  type Refusal,
} from "./schemas";
import { propose } from "./transitions";

interface ChecklistReceipt {
  instruction: string;
  detail: string;
}

interface ChecklistEntry {
  id: string;
  receipts: ChecklistReceipt[];
  remedyTokens: string[];
  targetTokens: string[];
}

const CREATED_AT = "2026-08-09T09:00:00.000Z";

function receipt(refusal: Refusal): ChecklistReceipt {
  return {
    instruction: refusal.instruction,
    detail: refusal.unmetConditions.join(" "),
  };
}

function revision(
  id: string,
  number: number,
  state: "proposed" | "approved" = "proposed",
) {
  return specRevisionSchema.parse({
    id,
    specId: "spec-1",
    number,
    state,
    authoringStage: "plan",
    basedOnRevisionId: null,
    contentHash: `sha256:${id}`,
    proposedAt: CREATED_AT,
    approvedAt: state === "approved" ? CREATED_AT : null,
    createdAt: CREATED_AT,
  });
}

function attempt(status: "draft" | "proposed" | "parked") {
  return specDeliveryPlanAttemptRowSchema.parse({
    id: "attempt-parked",
    spec_id: "spec-1",
    pinned_revision_id: "revision-approved",
    delta_basis_execution_id: null,
    status,
    draft_revision: 2,
    content_json: "{}",
    proposed_snapshot_id: status === "draft" ? null : "snapshot-1",
    approval_json: null,
    prelaunch_json: null,
    launched_execution_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
}

function refusalFrom<T extends { ok: false; refusal: Refusal }>(
  result: T,
): ChecklistReceipt {
  return receipt(result.refusal);
}

describe("native-SDD refusals-name-remedy checklist", () => {
  it("walks the exact inventory with target-specific remedies and no reminder overflow", () => {
    const removal = danglingReferenceRefusal([
      {
        code: "missing_target",
        sourceElementId: "criterion-1",
        field: "parentElementId",
        index: 0,
        targetId: "requirement-1",
        expectedKind: "requirement",
        actualKind: null,
        relation: "is contained by",
      },
    ]);
    const proposeDecision = propose({
      revisionState: "draft",
      authoringStage: "plan",
      policy: { preset: "contract-bearing" },
      draft: {
        specHandle: "native-sdd",
        authoringStage: "plan",
        elements: [],
      },
      records: {},
      review: {
        revisionId: "revision-draft",
        governanceBaseRevisionId: null,
        governanceBaseRevisionRows: [],
        revisionRows: [],
        importBaselineRows: null,
        blockingThreads: [],
        approvals: [],
      },
      approvalApplies: () => false,
    });
    if (proposeDecision.ok) throw new Error("blocking lint did not refuse");

    const signOff = strandedProposalSignOffRefusal(
      revision("revision-target", 4),
      revision("revision-stranded", 3),
    );
    const dismissHuman = dismissSupersededHumanActRefusal("revision-stranded");
    const dismissIneligible = dismissSupersededIneligibleRefusal(
      revision("revision-current", 5),
    );

    const candidate = {
      candidateId: "candidate-current",
      planHash: "sha256:plan-current",
      compiledDefinitionHash: "sha256:compiled-current",
    };
    const premature = prematureStartRefusal(
      "native-sdd",
      attempt("proposed"),
      candidate,
      null,
    );
    const reapproval = reapprovalRefusal(
      "native-sdd",
      attempt("parked"),
      {
        snapshotId: "snapshot-parked",
        candidateId: "candidate-parked",
        planHash: "sha256:plan-parked",
        compiledDefinitionHash: "sha256:compiled-parked",
        approvedAt: CREATED_AT,
        approvedBy: { kind: "human" },
      },
      candidate,
    );

    const abortBlocked = nextAbandonCleanupStep({
      phase: "release_slot",
      linkedWorkflow: {
        kind: "active",
        workflowExecutionId: "workflow-execution-1",
        status: "running",
      },
    });
    const releaseBlocked = nextAbandonCleanupStep({
      phase: "finalize",
      linkedWorkflow: {
        kind: "active",
        workflowExecutionId: "workflow-execution-1",
        status: "aborted",
      },
    });
    if (abortBlocked.act.kind !== "blocked") {
      throw new Error("live release cleanup did not refuse");
    }
    if (releaseBlocked.act.kind !== "blocked") {
      throw new Error("slot-owning finalization did not refuse");
    }

    const draftCapture = prelaunchRedirectRefusal(
      "native-sdd",
      attempt("draft"),
    );
    const proposedCapture = prelaunchRedirectRefusal(
      "native-sdd",
      attempt("proposed"),
    );
    const abandoningCapture = notRunningCaptureRefusal(
      "native-sdd",
      specExecutionRowSchema.parse({
        id: "spec-execution-1",
        spec_id: "spec-1",
        revision_id: "revision-approved",
        scope_json: "{}",
        state: "abandoning",
        execution_start_dial: "gate",
        workflow_definition_id: "definition-1",
        workflow_definition_revision: 1,
        workflow_execution_id: "workflow-execution-1",
        session_name: "session-1",
        delivered_at: null,
        abandoned_reason: "blocked",
        cleanup_phase: "release_slot",
        linked_workflow_execution_id: "workflow-execution-1",
        cleanup_last_error: "slot still owned",
        cleanup_last_error_at: CREATED_AT,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
      }),
    );
    if (draftCapture.ok || proposedCapture.ok || abandoningCapture.ok) {
      throw new Error("capture redirect unexpectedly succeeded");
    }

    const base = createWorkflowExecution({ status: "paused" });
    const contextId = base.workingDefinition.executionContexts[0]?.id;
    if (contextId === undefined) throw new Error("fixture has no context");
    const locked = applyLiveExecutionEdits(
      {
        ...base,
        workingDefinition: {
          ...base.workingDefinition,
          lockedRegions: [
            {
              paths: [`/executionContexts/${contextId}/acceptanceCriteria`],
              sourceUri: "spec://native-sdd/plans/attempt-parked",
              reason: "the delivery plan owns it",
              instruction:
                "Reopen with `cctl spec plan reopen native-sdd --reason <why>` or amend with `cctl workflow live amend --reason <why> --file <live-ops.json>`.",
            },
          ],
        },
      },
      {
        operations: [
          {
            type: "update-context",
            contextId,
            acceptanceCriteria: "Weakened criteria",
          },
        ],
      },
      // The production lock guard executes before any dependency is consulted.
      {} as never,
    );
    if (locked.ok || locked.instruction === undefined) {
      throw new Error("locked edit unexpectedly succeeded");
    }

    const inventory: ChecklistEntry[] = [
      {
        id: "element-removal",
        receipts: [receipt(removal)],
        remedyTokens: ["reintroduceHistorical"],
        targetTokens: ["criterion-1", "requirement-1"],
      },
      {
        id: "propose-lint-refusal",
        receipts: [receipt(proposeDecision.refusal)],
        remedyTokens: [
          "cctl spec lint native-sdd",
          "cctl spec propose native-sdd --notes <notes.md>",
        ],
        targetTokens: ["revision-draft", "native-sdd"],
      },
      {
        id: "sign-off-live-sibling-recheck",
        receipts: [receipt(signOff)],
        remedyTokens: ["Dismiss superseded proposal", "withdraw-proposal"],
        targetTokens: ["revision-stranded"],
      },
      {
        id: "dismiss-refusals",
        receipts: [receipt(dismissHuman), receipt(dismissIneligible)],
        remedyTokens: ["Spec Studio", "withdraw-proposal"],
        targetTokens: ["revision-stranded", "revision-current"],
      },
      {
        id: "premature-start",
        receipts: [receipt(premature)],
        remedyTokens: ["cctl spec plan sign-off native-sdd"],
        targetTokens: ["attempt-parked", "candidate-current"],
      },
      {
        id: "partial-abandon-release",
        receipts: [
          {
            instruction: abortBlocked.act.remedy,
            detail: abortBlocked.act.reason,
          },
          {
            instruction: releaseBlocked.act.remedy,
            detail: releaseBlocked.act.reason,
          },
        ],
        remedyTokens: [
          "cctl workflow live abort",
          "cctl workflow live release",
        ],
        targetTokens: ["workflow-execution-1"],
      },
      {
        id: "parked-candidate-hash-change",
        receipts: [receipt(reapproval)],
        remedyTokens: ["cctl spec plan preview", "sign-off"],
        targetTokens: ["sha256:compiled-parked", "sha256:compiled-current"],
      },
      {
        id: "capture-redirects",
        receipts: [
          refusalFrom(draftCapture),
          refusalFrom(proposedCapture),
          refusalFrom(abandoningCapture),
        ],
        remedyTokens: [
          "cctl spec plan edit native-sdd",
          "cctl spec plan reopen native-sdd",
          "cctl spec abandon --execution spec-execution-1",
        ],
        targetTokens: ["attempt-parked", "spec-execution-1"],
      },
      {
        id: "locked-edit-refusal",
        receipts: [
          {
            instruction: locked.instruction,
            detail: locked.issues.map(({ message }) => message).join(" "),
          },
        ],
        remedyTokens: [
          "cctl spec plan reopen native-sdd",
          "cctl workflow live amend",
        ],
        targetTokens: [base.id],
      },
    ];

    expect(inventory.map(({ id }) => id)).toEqual([
      "element-removal",
      "propose-lint-refusal",
      "sign-off-live-sibling-recheck",
      "dismiss-refusals",
      "premature-start",
      "partial-abandon-release",
      "parked-candidate-hash-change",
      "capture-redirects",
      "locked-edit-refusal",
    ]);

    for (const entry of inventory) {
      const rendered = entry.receipts
        .map(({ instruction, detail }) => `${detail} ${instruction}`)
        .join(" ");
      for (const token of entry.remedyTokens) {
        expect(rendered, `${entry.id} omits remedy ${token}`).toContain(token);
      }
      for (const token of entry.targetTokens) {
        expect(rendered, `${entry.id} omits target ${token}`).toContain(token);
      }
      for (const item of entry.receipts) {
        expect(item.instruction, `${entry.id} has no instruction`).not.toBe("");
      }
    }

    const reminders = computeLaneReminders({
      verb: "task-complete",
      iterationCount: 2,
      circuitBreakerThreshold: 3,
      remainingTaskCount: 0,
      halted: "iteration halted: circuit_breaker",
      allowAgentCollaboration: true,
      contextLimitStopped: false,
    });
    expect(reminders).toHaveLength(MAX_REMINDERS);
    expect(reminders[0]).toContain("used 2 of 3 iterations");
    expect(reminders[1]).toContain("iteration halted: circuit_breaker");
  });
});
