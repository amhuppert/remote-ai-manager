/**
 * Cross-boundary invariants for the workflow-scoped collaboration envelope
 * (Task 5.3).
 *
 * Three assertions:
 *
 *  1. No-pause invariant — the transitive on-disk import closure of
 *     `workflow-envelope.ts` excludes the human-approval-gate module, the
 *     `pauseForHumanApproval` symbol, and the user-triggered envelope module.
 *     The ESLint rule blocks direct imports; this test extends the guarantee
 *     to deeper transitive imports the linter cannot reach.
 *
 *  2. Parity at the shared policy boundary — both envelopes route their
 *     round outcomes through `decideCollaborationNextStep` (re-exported from
 *     `./policy`). For an identical canned `CollaborationResolutionDecisionOutput`
 *     plus identical config, the workflow envelope's policy step must
 *     produce the same `CollaborationPolicyDecision` as a direct call to the
 *     shared module. Terminal-result formatting may differ between the two
 *     envelopes (one returns a `WorkflowCollaborationResult`, the other
 *     persists artifacts to a lane store), so the parity claim is restricted
 *     to round-level policy agreement.
 *
 *  3. Discriminated snapshot round-trip — write a workflow-origin snapshot
 *     through the workflow envelope, read it back via the primitive envelope
 *     store, assert the discriminated parser recovers
 *     `parentImplementerTurnId`. Also: a captured user-origin snapshot
 *     persisted before the discriminator existed (no `origin` field) still
 *     parses as the `user` variant via the schema's preprocess fallback.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkflowEnvelopeStore } from "@/lib/workflows/primitives/workflow-envelope-store";
import { decideCollaborationNextStep } from "./policy";
import {
  collaborationFeatureSnapshotSchema,
  type CollaborationFeatureSnapshotUser,
  type CollaborationFeatureSnapshotWorkflow,
} from "./feature-snapshot";
import {
  createWorkflowCollaborationEnvelope,
  type WorkflowCollaborationEnvelopeDeps,
} from "./workflow-envelope";
import type { CollaborationPolicyDecision } from "./policy";
import type {
  CollaborationCounterProposalOutput,
  CollaborationProposedChangesOutput,
  CollaborationResolutionDecisionOutput,
  ResolvedCollaborationConfig,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  makeAgentOneInitialDraft,
  makeAgentOneProposedChanges,
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCrossReview,
  makeAgentTwoInitialDraft,
  makeFinalAnswer,
  makeObjectiveDisagreement,
  makeResolutionDecisionAskUser,
  makeResolutionDecisionFinal,
} from "./test-fixtures";

const AGENT_ONE_DRAFT = makeAgentOneInitialDraft({
  summary: "agent_one draft narrative",
  assumptions: [],
  key_claims: [],
});

const AGENT_TWO_DRAFT = makeAgentTwoInitialDraft({
  summary: "agent_two draft narrative",
  assumptions: [],
  key_claims: [],
});

const AGENT_TWO_CROSS_REVIEW = makeAgentTwoCrossReview({
  summary: "agent_two cross review narrative",
  agree: [],
  disagree: [],
  revise_self: [],
});

const PROPOSED_CHANGES: CollaborationProposedChangesOutput =
  makeAgentOneProposedChanges({
    summary: "agent_one proposed changes narrative",
    accepted_from_other_agent_draft: [],
    proposed_changes: [],
    remaining_disagreements: [],
  });

const COUNTER_PROPOSAL: CollaborationCounterProposalOutput =
  makeAgentTwoCounterProposalRound1({
    summary: "agent_two counter proposal narrative",
    accepted_change_ids: [],
    rejected_change_ids: [],
    alternative_changes: [],
    agree: [],
    disagree: [],
  });

function makeRoundOutput(resolution: CollaborationResolutionDecisionOutput): {
  proposedChanges: CollaborationProposedChangesOutput;
  counterProposal: CollaborationCounterProposalOutput;
  resolution: CollaborationResolutionDecisionOutput;
} {
  return {
    proposedChanges: PROPOSED_CHANGES,
    counterProposal: COUNTER_PROPOSAL,
    resolution,
  };
}

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(__dirname, "../../..");
const WORKFLOW_ENVELOPE_PATH = path.resolve(
  __dirname,
  "./workflow-envelope.ts",
);
const HUMAN_APPROVAL_GATE_PATH = path.resolve(
  SRC_ROOT,
  "lib/workflows/primitives/human-approval-gate.ts",
);
const USER_ENVELOPE_PATH = path.resolve(__dirname, "./envelope.ts");

const IMPORT_REGEX =
  /(?:^|\n)\s*(?:import\s+(?:[^"']*?\s+from\s+)?|export\s+(?:[^"']*?\s+from\s+))(?:["']([^"']+)["'])/g;

function resolveImportSpecifier(
  fromFile: string,
  specifier: string,
): string | null {
  if (specifier.startsWith("node:")) return null;
  if (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("@/")
  ) {
    // bare external (e.g., 'zod') — outside the project source tree
    return null;
  }

  const baseDir = specifier.startsWith("@/")
    ? SRC_ROOT
    : path.dirname(fromFile);
  const tail = specifier.startsWith("@/") ? specifier.slice(2) : specifier;
  const candidate = path.resolve(baseDir, tail);

  const tryExtensions = [".ts", ".tsx", ".d.ts"];
  for (const ext of tryExtensions) {
    const withExt = candidate + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
  }
  for (const ext of tryExtensions) {
    const indexFile = path.join(candidate, "index" + ext);
    if (existsSync(indexFile) && statSync(indexFile).isFile()) return indexFile;
  }
  // Some imports point at a .ts file that physically does not exist (e.g.,
  // an external module that resolves via tsconfig paths or types). Skip them.
  return null;
}

function collectTransitiveImports(
  entry: string,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  if (!existsSync(entry)) return seen;
  const source = readFileSync(entry, "utf8");
  for (const match of source.matchAll(IMPORT_REGEX)) {
    const specifier = match[1];
    if (!specifier) continue;
    const resolved = resolveImportSpecifier(entry, specifier);
    if (resolved) {
      collectTransitiveImports(resolved, seen);
    }
  }
  return seen;
}

const RESOLVED_CONFIG: ResolvedCollaborationConfig = {
  secondAgent: {
    value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "medium" },
    source: "global",
  },
  negotiationRounds: { value: 1, source: "global" },
  autonomousResolutionThreshold: { value: "minor", source: "global" },
};

const RESOLUTION_AGREED: CollaborationResolutionDecisionOutput =
  makeResolutionDecisionFinal({
    accepted_points: [],
    resolved_disagreements: [],
    remaining_disagreements: [],
    user_questions: [],
    rationale: "agreed",
  });

const FINAL_ANSWER_TEXT = "Adopt Postgres for the new service tier.";
const FINAL_ANSWER = makeFinalAnswer({
  summary: "Both agents agreed on Postgres.",
});

const FINAL_ANSWER_NA_TEXT = "n/a";
const FINAL_ANSWER_NA = makeFinalAnswer({
  summary: "n/a",
});

const START_ARGS = {
  brief: "Should we adopt Postgres?",
  resolvedConfig: RESOLVED_CONFIG,
  parentImplementerTurnId: "turn-7",
  executionContextId: "context-implement",
  conversationId: "conv-abc",
  executionId: "execution-1",
  iterationIndex: 0,
} as const;

function buildWorkflowDeps(overrides?: {
  policyDecide?: WorkflowCollaborationEnvelopeDeps["policyDecide"];
}): WorkflowCollaborationEnvelopeDeps {
  return {
    envelopeStore: createInMemoryWorkflowEnvelopeStore(),
    policyDecide:
      overrides?.policyDecide ??
      (() => ({ kind: "final" }) satisfies CollaborationPolicyDecision),
    collaboratorCaller: {
      runInitialDrafts: vi.fn(async () => ({
        agentOneDraft: AGENT_ONE_DRAFT,
        agentTwoDraft: AGENT_TWO_DRAFT,
      })),
      runCrossReview: vi.fn(async () => ({
        agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
      })),
      runRound: vi.fn(async () => makeRoundOutput(RESOLUTION_AGREED)),
      generateFinalAnswer: vi.fn(async () => ({
        finalAnswer: FINAL_ANSWER,
        finalAnswerText: FINAL_ANSWER_TEXT,
      })),
    },
    now: () => "2026-05-31T00:00:00.000Z",
    workflowIdFactory: () => "wf-invariants-1",
  };
}

describe("Task 5.3 — workflow envelope cross-boundary invariants", () => {
  describe("no-pause invariant: transitive import closure", () => {
    it("the transitive import closure of workflow-envelope.ts excludes the human-approval-gate module", () => {
      const closure = collectTransitiveImports(WORKFLOW_ENVELOPE_PATH);
      const closureRelative = [...closure].map((p) =>
        path.relative(REPO_ROOT, p),
      );
      expect(closure.has(HUMAN_APPROVAL_GATE_PATH)).toBe(false);
      // Sanity: closure non-empty and includes a known direct import.
      expect(closureRelative.length).toBeGreaterThan(0);
      expect(
        closureRelative.some((rel) => rel.endsWith("collaboration/policy.ts")),
      ).toBe(true);
    });

    it("the transitive import closure of workflow-envelope.ts excludes the user-triggered envelope module", () => {
      const closure = collectTransitiveImports(WORKFLOW_ENVELOPE_PATH);
      expect(closure.has(USER_ENVELOPE_PATH)).toBe(false);
    });

    it("guard test: the same walker DOES find the human-approval-gate module from the user-triggered envelope (closure-walker not silently broken)", () => {
      const closureFromUserEnvelope =
        collectTransitiveImports(USER_ENVELOPE_PATH);
      expect(closureFromUserEnvelope.has(HUMAN_APPROVAL_GATE_PATH)).toBe(true);
    });
  });

  describe("parity at the shared policy boundary", () => {
    it("the workflow envelope's policy step produces the same CollaborationPolicyDecision as a direct call to decideCollaborationNextStep with the same inputs", async () => {
      const policyDecideSpy = vi.fn(decideCollaborationNextStep);
      const deps = buildWorkflowDeps({ policyDecide: policyDecideSpy });

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      expect(policyDecideSpy).toHaveBeenCalledTimes(1);
      const callArgs = policyDecideSpy.mock.calls[0]?.[0];
      const envelopeReturnedDecision = policyDecideSpy.mock.results[0]?.value;

      expect(callArgs).toBeDefined();
      const directDecision = decideCollaborationNextStep({
        decision: callArgs!.decision,
        autonomousResolutionThreshold: callArgs!.autonomousResolutionThreshold,
        negotiationRoundsRemaining: callArgs!.negotiationRoundsRemaining,
      });

      expect(envelopeReturnedDecision).toEqual(directDecision);
      expect(envelopeReturnedDecision).toEqual({ kind: "final" });
    });

    it("for a canned round 1 resolution with a single objective disagreement, both code paths (workflow envelope + direct policy) agree on ask_user/objective_disagreement", async () => {
      const objectiveResolution: CollaborationResolutionDecisionOutput =
        makeResolutionDecisionAskUser({
          remaining_disagreements: [
            makeObjectiveDisagreement({
              id: "d1",
              claim: "User intent is ambiguous",
              reason: "Need clarification",
            }),
          ],
          user_questions: [],
          rationale: "objective disagreement",
        });
      const policyDecideSpy = vi.fn(decideCollaborationNextStep);
      const deps: WorkflowCollaborationEnvelopeDeps = {
        ...buildWorkflowDeps({ policyDecide: policyDecideSpy }),
        collaboratorCaller: {
          runInitialDrafts: vi.fn(async () => ({
            agentOneDraft: AGENT_ONE_DRAFT,
            agentTwoDraft: AGENT_TWO_DRAFT,
          })),
          runCrossReview: vi.fn(async () => ({
            agentTwoCrossReview: AGENT_TWO_CROSS_REVIEW,
          })),
          runRound: vi.fn(async () => makeRoundOutput(objectiveResolution)),
          generateFinalAnswer: vi.fn(async () => ({
            finalAnswer: FINAL_ANSWER_NA,
            finalAnswerText: FINAL_ANSWER_NA_TEXT,
          })),
        },
      };

      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const callArgs = policyDecideSpy.mock.calls[0]?.[0];
      const envelopeDecision = policyDecideSpy.mock.results[0]?.value;

      const directDecision = decideCollaborationNextStep({
        decision: callArgs!.decision,
        autonomousResolutionThreshold: callArgs!.autonomousResolutionThreshold,
        negotiationRoundsRemaining: callArgs!.negotiationRoundsRemaining,
      });

      expect(envelopeDecision).toEqual(directDecision);
      expect(envelopeDecision?.kind).toBe("ask_user");
    });
  });

  describe("discriminated snapshot round-trip", () => {
    it("writes a workflow-origin snapshot recoverable through the discriminated parser with parentImplementerTurnId intact", async () => {
      const deps = buildWorkflowDeps();
      await createWorkflowCollaborationEnvelope(deps).start(START_ARGS);

      const persisted = await deps.envelopeStore.read("wf-invariants-1");
      expect(persisted).not.toBeNull();

      const parsed = collaborationFeatureSnapshotSchema.parse(
        persisted?.featureSnapshot,
      );
      expect(parsed.origin).toBe("workflow");
      const workflow = parsed as CollaborationFeatureSnapshotWorkflow;
      expect(workflow.parentImplementerTurnId).toBe("turn-7");
      expect(workflow.executionContextId).toBe("context-implement");
      expect(workflow.conversationId).toBe("conv-abc");
      expect(workflow.resolvedConfig.secondAgent.source).toBe("global");
    });

    it("parses a captured user-origin snapshot lacking the origin field as the user variant via the schema preprocess fallback", () => {
      const capturedLegacyUserSnapshot = {
        prompt: "Should we adopt Postgres?",
        autonomousResolutionThreshold: "minor",
        negotiationRounds: 3,
        agentOne: { backend: "claude", model: "opus" },
        agentTwo: { backend: "codex", model: "gpt-5.4" },
        capturedAt: "2026-04-12T10:00:00.000Z",
      };

      const parsed = collaborationFeatureSnapshotSchema.parse(
        capturedLegacyUserSnapshot,
      );
      expect(parsed.origin).toBe("user");
      const userVariant = parsed as CollaborationFeatureSnapshotUser;
      expect((userVariant as unknown as Record<string, unknown>).prompt).toBe(
        "Should we adopt Postgres?",
      );
    });

    it("rejects a workflow-origin snapshot missing parentImplementerTurnId", () => {
      const incompleteWorkflowSnapshot = {
        origin: "workflow",
        executionContextId: "context-implement",
        conversationId: "conv-abc",
        resolvedConfig: RESOLVED_CONFIG,
      };
      const result = collaborationFeatureSnapshotSchema.safeParse(
        incompleteWorkflowSnapshot,
      );
      expect(result.success).toBe(false);
    });
  });
});
