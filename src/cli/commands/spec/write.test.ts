import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SpecGatePreset } from "@/lib/specs/schemas";
import type { SpecProposeApprovalRequest } from "@/lib/specs/view-schemas";
import { revisionInReviewInstruction } from "@/lib/specs/authoring-service";
import { inlineDataOf, runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

const CREATED_AT = "2026-07-18T00:00:00.000Z";
// Built from the server's own instruction builder: a hand-copied string here
// would let the CLI test keep passing after the recovery it teaches changed.
const REVISION_IN_REVIEW_INSTRUCTION = revisionInReviewInstruction(
  [2],
  "amendment",
);
const SPEC_FILE = "/tmp/spec-element.json";
const DRAFT_FILE = "/tmp/spec-draft-element.json";
const BATCH_FILE = "/tmp/spec-elements.json";
const SCOPE_FILE = "/tmp/spec-scope.json";
const INPUTS_FILE = "/tmp/spec-start-inputs.json";
const TASK_FILE = "/tmp/spec-discovered-task.json";

const spec = {
  id: "spec-1",
  projectPath: "/repos/demo",
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const SPEC_SCOPE = {
  selectedTaskIds: ["task-id-1"],
  selectedCriterionIds: ["criterion-id-1"],
  exclusionDispositions: [
    { criterionId: "criterion-id-2", disposition: "deferred" },
  ],
};

function revision(state: "draft" | "approved" = "draft") {
  return {
    id: state === "draft" ? "revision-draft" : "revision-approved",
    specId: spec.id,
    number: 1,
    state,
    authoringStage: state === "draft" ? "requirements" : "plan",
    basedOnRevisionId: null,
    contentHash: state === "draft" ? null : "approved-hash",
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "a".repeat(64),
    proposedAt: state === "draft" ? null : CREATED_AT,
    approvedAt: state === "draft" ? null : CREATED_AT,
    createdAt: CREATED_AT,
  };
}

function statusBody() {
  return {
    specId: spec.id,
    slug: spec.slug,
    phase: { primary: "draft" },
    gates: [],
    pendingApprovals: [],
    openQuestions: [
      {
        id: "question-id-1",
        handle: "Q1",
        recordVersion: 3,
        text: "Which scope?",
        elementId: null,
      },
    ],
    coverage: { coveredCriteria: 1, totalCriteria: 1, percentage: 100 },
  };
}

function detailBody(
  state: "draft" | "approved" = "draft",
  preset = "contract-bearing",
) {
  const current = revision(state);
  return {
    spec: { ...spec, gatePolicy: { preset } },
    aliases: [],
    revisions: [current],
    currentRevision: {
      revision: current,
      elements: [],
      assumptionCitations: [],
    },
    status: {
      ...statusBody(),
      phase: { primary: state },
    },
  };
}

/**
 * The elements the fixture draft carries, addressed the way an author does.
 * The edit-context read resolves a handle to exactly this record, which is
 * what lets a removal state an element id and the version it is taking out.
 */
const DRAFT_ELEMENTS_BY_HANDLE: Record<
  string,
  { elementId: string; kind: string; elementVersion: number; position: number }
> = {
  R1: {
    elementId: "requirement-id-1",
    kind: "requirement",
    elementVersion: 3,
    position: 0,
  },
  "R1.1": {
    elementId: "criterion-id-1",
    kind: "criterion",
    elementVersion: 1,
    position: 1,
  },
  T1: {
    elementId: "task-id-1",
    kind: "task",
    elementVersion: 2,
    position: 2,
  },
};

// The write path's own read: everything a write must name and nothing else.
function editContextBody(
  state: "draft" | "approved" = "draft",
  preset = "contract-bearing",
  requestedElement: string | null = null,
) {
  const current = revision(state);
  const found =
    requestedElement === null
      ? undefined
      : DRAFT_ELEMENTS_BY_HANDLE[requestedElement];
  return {
    specId: spec.id,
    slug: spec.slug,
    name: spec.name,
    gatePolicy: { preset },
    currentRevision: {
      id: current.id,
      number: current.number,
      state: current.state,
      authoringStage: current.authoringStage,
    },
    latestApprovedRevision:
      state === "approved" ? { id: current.id, number: current.number } : null,
    element:
      found === undefined ? null : { handle: requestedElement, ...found },
  };
}

function batchElement(
  elementId: string,
  kind: "requirement" | "criterion",
  number: number,
  parentElementId: string | null,
) {
  return {
    id: elementId,
    specId: spec.id,
    kind,
    number,
    parentElementId,
    createdAt: CREATED_AT,
  };
}

function batchVersion(
  elementId: string,
  elementVersion: number,
  payload: unknown,
) {
  return {
    revisionId: "revision-draft",
    elementId,
    position: 0,
    payload,
    payloadHash: `${elementId}-hash`,
    elementVersion,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

const REQUIREMENT_PAYLOAD = {
  kind: "requirement",
  statement: "Candidate content",
  priority: "must",
  risk: "high",
};

const CRITERION_PAYLOAD = {
  kind: "criterion",
  text: "A batch write reports every element it wrote.",
  validationStrategy: { kinds: ["test_run"], note: "CLI contract test" },
};

function taskElementBody() {
  const current = revision("approved");
  return {
    specId: spec.id,
    slug: spec.slug,
    revision: current,
    handle: "T1",
    element: {
      element: {
        id: "task-id-1",
        specId: spec.id,
        kind: "task",
        number: 1,
        parentElementId: null,
        createdAt: CREATED_AT,
      },
      version: {
        revisionId: current.id,
        elementId: "task-id-1",
        position: 0,
        payload: {
          kind: "task",
          title: "Implement the CLI",
          instructions: "Ship the write verbs.",
          tracedRequirementElementIds: ["requirement-id-1"],
          tracedDecisionElementIds: [],
          coveredCriterionElementIds: ["criterion-id-1"],
          dependsOnTaskElementIds: [],
        },
        payloadHash: "task-hash",
        elementVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    },
    approvals: [],
    evidenceState: [],
    referenceState: null,
  };
}

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "contract-token",
  CC_PROJECT: "demo",
  CC_SESSION: "feature-session",
  CC_CONVERSATION_ID: "conversation-1",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  options: {
    files?: Record<string, string>;
    refusal?:
      | "propose"
      | "draft-upsert"
      | "draft-batch"
      | "draft-batch-dangling"
      | "rename"
      | "capture-scope-amendment"
      | "abandon-spec"
      | "answer-question"
      | "open-amendment";
    approved?: boolean;
    /** Drives the execution_start dial the CLI resolves locally. */
    preset?: SpecGatePreset;
    /** The approval ask was already open, so no second request was created. */
    alreadyRequested?: boolean;
    /** The request committed but its Needs You notice may not have landed. */
    deliveryUncertain?: boolean;
    /** A revision was withdrawn above the base the amendment clones. */
    skippedWithdrawn?: boolean;
    /** Every dial concluded the stage, so the propose absorbed the sign-off. */
    absorbedSignOff?: boolean;
    /** What the server's post-commit coordinator did about each gate's ask. */
    proposeApprovalRequests?: readonly SpecProposeApprovalRequest[];
    /** Exercises rejection of a malformed current-build batch refusal. */
    omitBatchInstruction?: boolean;
    /** Exercises terminal-line flattening on authored batch identifiers. */
    unsafeBatchGuidance?: boolean;
    /** Multiple subjects share the next gate, so one subjectless request covers it. */
    wholeGateNextAction?: boolean;
    /** A blocking gate carries a subject the import settled, not a human. */
    importCarried?: boolean;
    /** Citation state returned by the attention-record read preflight. */
    assumptionCitationState?: "no-draft" | "uncited" | "cited";
    /** The read target already has a durable successor. */
    assumptionSuperseded?: boolean;
    /** Return an attention edit receipt whose citation versions changed. */
    citedAttentionReceipt?: boolean;
    /**
     * Blocking finding counts the lint read answers with, consumed in order —
     * the first is the draft before the write, the second after it.
     */
    blockingCounts?: readonly number[];
    /** No draft to lint — the shape a server answers a spec with no revision. */
    lintUnavailable?: boolean;
    /**
     * The start-execution answer, for the delivery-plan shapes: a launch that
     * ran an approved candidate, and a park that launched nothing.
     */
    startBody?: { body: unknown; status?: number };
  } = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const handle = (value: string) => ({ handle: value });
  let lintReads = 0;
  // The server's account of the same subjects the pending block enumerates:
  // R1 outstanding on this revision, R0 already settled — by an ancestor
  // revision's human approval, or by the import, in step with what the gate
  // reports as import-carried so the two halves cannot contradict each other.
  const settledClassification = options.importCarried
    ? ("import_settled" as const)
    : ("carried" as const);
  const approvalLedger = {
    subjects: [
      {
        gate: "requirements" as const,
        subject: "R0",
        elementId: "requirement-id-0",
        classification: settledClassification,
      },
      {
        gate: "requirements" as const,
        subject: "R1",
        elementId: "requirement-id-1",
        classification: "pending" as const,
      },
    ],
    satisfied: 1,
    carried: options.importCarried ? 0 : 1,
    currentRevision: 0,
    importSettled: options.importCarried ? 1 : 0,
    combinedAct: 0,
    pending: 1,
    governedBy: "per_subject" as const,
    carryRule: "unchanged subject content under the same applicable gate",
  };
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (init.method === "GET") {
        if (pathname.endsWith("/elements/Q1")) {
          return response({
            specId: spec.id,
            slug: spec.slug,
            kind: "question",
            handle: "Q1",
            question: {
              id: "question-id-1",
              number: 1,
              handle: "Q1",
              elementId: null,
              text: "Which scope?",
              recordVersion: 3,
              status: "open",
              answer: null,
              answeredAt: null,
              withdrawnAt: null,
              provenance: null,
              presentation: {
                state: "current",
                attentionActive: true,
                lastMutation: null,
                humanCapability: { kind: "answer", allowed: true },
              },
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
          });
        }
        if (pathname.endsWith("/elements/A1")) {
          const citationState = options.assumptionCitationState ?? "no-draft";
          const currentDraftCitations =
            citationState === "no-draft"
              ? null
              : {
                  revisionId: "revision-draft",
                  citationVersion: 2,
                  citationHash: "a".repeat(64),
                  citations:
                    citationState === "uncited"
                      ? []
                      : [
                          {
                            revisionId: "revision-draft",
                            specId: spec.id,
                            elementId: "requirement-id-1",
                            assumptionId: "assumption-id-1",
                            elementHandle: "R1",
                            snapshot: {
                              schemaVersion: 1,
                              captureKind: "native",
                              capturedAt: CREATED_AT,
                              assumptionId: "assumption-id-1",
                              number: 1,
                              recordVersion: 1,
                              text: "SQLite remains authoritative.",
                              elementId: null,
                              proposedBy: {
                                kind: "agent",
                                conversationId: "conversation-1",
                              },
                              disposition: "proposed",
                              disposedAt: null,
                              withdrawnAt: null,
                              supersedesAssumptionId: null,
                              createdAt: CREATED_AT,
                              updatedAt: CREATED_AT,
                            },
                            createdAt: CREATED_AT,
                            updatedAt: CREATED_AT,
                          },
                        ],
                };
          return response({
            specId: spec.id,
            slug: spec.slug,
            kind: "assumption",
            handle: "A1",
            assumption: {
              id: "assumption-id-1",
              number: 1,
              handle: "A1",
              elementId: null,
              text: "SQLite remains authoritative.",
              recordVersion: 1,
              disposition: "proposed",
              disposedAt: null,
              withdrawnAt: null,
              proposedBy: {
                kind: "agent",
                conversationId: "conversation-1",
              },
              supersedesHandle: null,
              supersededByHandle:
                options.assumptionSuperseded === true ? "A2" : null,
              currentDraftCitations,
              presentation: {
                state: "current",
                attentionActive: true,
                lastMutation: null,
                humanCapability: { kind: "dispose", allowed: true },
              },
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
          });
        }
        if (pathname.endsWith("/status")) return response(statusBody());
        if (pathname.endsWith("/lint")) {
          if (options.lintUnavailable === true) {
            return response({ error: "Spec draft not found" }, 404);
          }
          const blocking = options.blockingCounts?.[lintReads] ?? 0;
          lintReads += 1;
          return response({
            revisionId: "revision-draft",
            findings: Array.from({ length: blocking }, (_unused, index) => ({
              ruleId: "9.3.uncovered-criterion",
              severity: "blocks_propose",
              elementHandle: `R1.${index + 1}`,
              message: `R1.${index + 1} has no covering task.`,
            })),
          });
        }
        if (pathname.endsWith("/edit-context"))
          return response(
            editContextBody(
              options.approved ? "approved" : "draft",
              options.preset,
              parsed.searchParams.get("element"),
            ),
          );
        if (pathname.includes("/elements/T1"))
          return response(taskElementBody());
        return response(
          detailBody(options.approved ? "approved" : "draft", options.preset),
        );
      }

      const action = pathname.split("/").at(-1);
      if (options.refusal === "propose" && action === "propose") {
        const findings = [
          {
            ruleId: "criterion_coverage",
            severity: "blocks_propose",
            elementHandle: "R1.1",
            message: "R1.1 has no covering task",
          },
        ];
        return response(
          {
            code: "lint_blocked",
            unmetConditions: findings.map((finding) => finding.message),
            findings,
            instruction:
              "Resolve the blocking lint findings and propose again.",
          },
          409,
        );
      }
      if (options.refusal === "abandon-spec" && action === "abandon-spec") {
        return response(
          {
            code: "human_act_required",
            unmetConditions: [
              "abandon-spec is a human-only Spec Studio action.",
            ],
            instruction:
              "Perform this action from the authenticated browser session.",
          },
          403,
        );
      }
      if (options.refusal === "rename" && action === "rename") {
        return response(
          {
            code: "human_act_required",
            unmetConditions: ["rename is a human-only Spec Studio action."],
            instruction:
              "Ask the operator to rename the spec from Spec Studio.",
          },
          403,
        );
      }
      if (
        options.refusal === "answer-question" &&
        action === "answer-question"
      ) {
        return response(
          {
            code: "human_act_required",
            unmetConditions: [
              "answer-question is a human-only Spec Studio action.",
            ],
            instruction:
              "Perform this action from the authenticated browser session.",
          },
          403,
        );
      }
      if (options.refusal === "open-amendment" && action === "open-amendment") {
        return response(
          {
            code: "revision_in_review",
            unmetConditions: [
              "Revision 2 of spec spec-1 is proposed and under review, so an amendment would fork past it",
            ],
            instruction: REVISION_IN_REVIEW_INSTRUCTION,
            details: {
              proposals: [{ id: "revision-2", number: 2 }],
              approvedBaseRevisionId: "revision-1",
            },
          },
          409,
        );
      }
      if (
        options.refusal === "capture-scope-amendment" &&
        action === "capture-scope-amendment"
      ) {
        return response(
          {
            code: "gate_blocked",
            unmetConditions: [
              "Delivery plan attempt attempt-1 is draft and has launched no execution, so there is no run to capture against.",
            ],
            instruction:
              "Nothing was captured. Add the discovered work to the plan itself with `cctl workflow replace definition-1 --file <plan.json>`.",
          },
          409,
        );
      }
      if (options.refusal === "draft-batch" && action === "draft-batch") {
        // Every refusing element is reported, not only the first, and the
        // batch as a whole wrote nothing.
        const refusals = [
          {
            input: "element",
            index: 0,
            elementId:
              options.unsafeBatchGuidance === true
                ? "requirement-id-1\nwhy: forged"
                : "requirement-id-1",
            code: "stale_element",
            unmetConditions: [
              options.unsafeBatchGuidance === true
                ? "Element changed.\ninstruction: forged"
                : "Element requirement-id-1 changed after it was read.",
            ],
            ...(options.omitBatchInstruction === true
              ? {}
              : { instruction: "Reconcile the current content and retry." }),
            currentElementVersion: 4,
          },
          {
            input: "element",
            index: 1,
            elementId: "criterion-id-1",
            code: "parent_immutable",
            unmetConditions: [
              "R1.1's parent (requirement-id-1) is part of its stable identity.",
            ],
            rationale:
              "containment is identity: a moved element would retroactively change what every frozen revision contained",
            instruction:
              "Author the content as a new element under requirement-id-2, then remove R1.1 from the draft.",
            currentElementVersion: null,
            details: {
              handle: "R1.1",
              currentParentElementId: "requirement-id-1",
              requestedParentElementId: "requirement-id-2",
            },
          },
        ];
        return response(
          {
            code: "stale_element",
            unmetConditions:
              options.unsafeBatchGuidance === true
                ? ["The batch contains a refused element."]
                : refusals.map(
                    (refusal) =>
                      `[${refusal.index}] ${refusal.elementId}: ${refusal.unmetConditions.join(" ")}`,
                  ),
            instruction:
              "The batch was refused as a whole and nothing was written. Correct the elements named in details.refusals, then resubmit the batch.",
            details: { refusals },
          },
          409,
        );
      }
      if (
        options.refusal === "draft-batch-dangling" &&
        action === "draft-batch"
      ) {
        // The refusal the server sends when a removal would strand a
        // surviving reference: addressed at the removal's own index, and
        // carrying the handles both ends of the reference are known by.
        const refusals = [
          {
            input: "removal",
            index: 0,
            elementId: "criterion-id-1",
            code: "dangling_reference",
            unmetConditions: [
              "task-id-1.coveredCriterionElementIds[0] covers criterion criterion-id-1, which is not in this revision.",
            ],
            instruction:
              "Nothing was written. Rewrite or remove task-id-1 in the same write: drop the entry, repoint it at an element this revision carries, or remove the source alongside its target.",
            currentElementVersion: null,
            danglingReferences: [
              {
                code: "missing_target",
                sourceElementId: "task-id-1",
                sourceHandle: "T1",
                field: "coveredCriterionElementIds",
                index: 0,
                targetId: "criterion-id-1",
                targetHandle: "R1.1",
                expectedKind: "criterion",
                actualKind: null,
                relation: "covers",
              },
            ],
          },
        ];
        return response(
          {
            code: "dangling_reference",
            unmetConditions: refusals.flatMap(
              (refusal) => refusal.unmetConditions,
            ),
            instruction:
              "The batch was refused as a whole and nothing was written.",
            details: { refusals },
          },
          409,
        );
      }
      if (options.refusal === "draft-upsert" && action === "draft-upsert") {
        return response(
          {
            code: "stale_element",
            unmetConditions: ["R1 changed after it was read."],
            details: {
              currentContent: {
                kind: "requirement",
                statement: "Winning content",
                priority: "must",
                risk: "high",
              },
              currentVersion: 2,
            },
            instruction:
              "Reconcile the current content and retry with version 2.",
          },
          409,
        );
      }

      switch (action) {
        case "reply": {
          const body: unknown = JSON.parse(init.body ?? "{}");
          const posted =
            typeof body === "object" && body !== null
              ? (body as { threadId?: string; body?: string })
              : {};
          // The reply action answers with the raw persisted row — the CLI owns
          // projecting it into the typed receipt.
          return response({
            id: "comment-reply-1",
            spec_id: spec.id,
            thread_id: posted.threadId ?? "",
            parent_comment_id: "comment-root-1",
            element_id: "requirement-id-1",
            anchor_json: JSON.stringify({ quote: "the anchored text" }),
            revision_id: "revision-draft",
            body: posted.body ?? "",
            author_json: JSON.stringify({
              kind: "agent",
              conversationId: "conversation-1",
            }),
            blocking: 0,
            resolution: "open",
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          });
        }
        case "rename":
          return response({
            spec: { ...spec, slug: "native-sdd-v2" },
            alias: {
              projectPath: spec.projectPath,
              slug: spec.slug,
              specId: spec.id,
              createdAt: CREATED_AT,
            },
          });
        case "create":
          return response({
            spec,
            draft: revision(),
            ...handle("R1"),
            element: {
              id: "requirement-id-1",
              specId: spec.id,
              kind: "requirement",
              number: 1,
              parentElementId: null,
              createdAt: CREATED_AT,
            },
            version: {
              revisionId: "revision-draft",
              elementId: "requirement-id-1",
              position: 0,
              payload: {
                kind: "requirement",
                statement: "Candidate content",
                priority: "must",
                risk: "high",
              },
              payloadHash: "requirement-hash",
              elementVersion: 1,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
          });
        case "draft-upsert":
          return response({
            element: taskElementBody().element.element,
            version: taskElementBody().element.version,
            ...handle("T1"),
          });
        case "draft-batch":
          return response({
            revisionId: "revision-draft",
            written: [
              {
                index: 0,
                elementId: "requirement-id-1",
                element: batchElement(
                  "requirement-id-1",
                  "requirement",
                  1,
                  null,
                ),
                version: batchVersion(
                  "requirement-id-1",
                  4,
                  REQUIREMENT_PAYLOAD,
                ),
                ...handle("R1"),
              },
              {
                index: 1,
                elementId: "criterion-id-1",
                element: batchElement(
                  "criterion-id-1",
                  "criterion",
                  1,
                  "requirement-id-1",
                ),
                version: batchVersion("criterion-id-1", 1, CRITERION_PAYLOAD),
                ...handle("R1.1"),
              },
            ],
          });
        case "propose":
          if (options.absorbedSignOff) {
            return response({
              revision: {
                ...revision("approved"),
                authoringStage: "requirements",
                number: 1,
              },
              diff: { classifications: [], changeList: [], planStale: false },
              absorbedSignOff: true,
              approvalLedger,
              // A propose that admitted its own gates owes no ask.
              approvalRequests: options.proposeApprovalRequests ?? [
                {
                  gate: "requirements",
                  outcome: "not-needed",
                  attentionId: null,
                },
              ],
              pendingBlock: null,
              nextAction: {
                kind: "none",
                actsNext: null,
                gate: null,
                subject: null,
                elementId: null,
                instruction: "Nothing is outstanding for the current revision.",
              },
            });
          }
          return response({
            // The revision sits at the plan stage while the gate it still owes
            // is requirements — the shape ticket #42 reported, so any rendering
            // that reads the stage names the wrong gate.
            revision: {
              ...revision(),
              authoringStage: "plan",
              state: "proposed",
              proposedAt: CREATED_AT,
            },
            diff: { classifications: [], changeList: [], planStale: false },
            absorbedSignOff: false,
            approvalLedger,
            // The propose filed the ask its pending gate owes before it
            // answered, so the caller is told the request already exists.
            approvalRequests: options.proposeApprovalRequests ?? [
              {
                gate: "requirements",
                outcome: "filed",
                attentionId: "attention-requirements",
              },
            ],
            // The server authors the blocker: which gates the transition
            // consulted, the subject each is waiting on, and the sign-off
            // standing. The stage alone cannot produce any of it.
            pendingBlock: {
              actsNext: "human",
              gates: [
                {
                  gate: "requirements",
                  dial: "gate",
                  state: "pending",
                  applicability: {
                    reason: "current_stage",
                    governanceBaseRevisionId: null,
                  },
                  subjects: ["R1"],
                  importCarriedSubjects: options.importCarried ? ["R0"] : [],
                },
              ],
              outstandingSubjects: [
                {
                  gate: "requirements",
                  subject: "R1",
                  elementId: "requirement-id-1",
                },
              ],
              signOff: {
                revisionId: "revision-draft",
                revisionNumber: 1,
                state: "blocked",
                outstandingSubjectCount: 1,
                unmetConditions: [
                  "Requirement R1 needs a valid approval for revision-draft.",
                ],
                approval: null,
              },
              unmetConditions: [
                "Requirement R1 needs a valid approval for revision-draft.",
              ],
              display: "revision 1 needs 1 human approval — requirements: R1",
              instruction:
                "Ask a human to approve R1 at the requirements gate in Spec Studio, or request it with gate requirements and subject R1.",
            },
            nextAction: options.wholeGateNextAction
              ? {
                  kind: "approve_gate",
                  actsNext: "human",
                  gate: "requirements",
                  subject: null,
                  elementId: null,
                  instruction:
                    "Ask a human to approve all outstanding subjects at the requirements gate in Spec Studio.",
                }
              : {
                  kind: "approve_subject",
                  actsNext: "human",
                  gate: "requirements",
                  subject: "R1",
                  elementId: "requirement-id-1",
                  instruction:
                    "Ask a human to approve R1 at the requirements gate in Spec Studio.",
                },
          });
        case "advance":
          return response({
            revision: {
              ...revision(),
              authoringStage: "design",
            },
          });
        case "return-to-requirements":
          return response({
            revision: {
              ...revision(),
              id: "revision-requirements-return",
              authoringStage: "requirements",
              basedOnRevisionId: "revision-requirements-approved",
            },
            withdrawnRevision: {
              ...revision(),
              id: "revision-design-withdrawn",
              state: "withdrawn",
              authoringStage: "design",
            },
          });
        case "answer-question":
          return response({
            id: "question-id-1",
            number: 1,
            handle: "Q1",
            elementId: null,
            text: "Which scope?",
            recordVersion: 2,
            status: "answered",
            answer: "The full scope.",
            answeredAt: CREATED_AT,
            withdrawnAt: null,
            provenance: null,
            presentation: {
              state: "current",
              attentionActive: false,
              lastMutation: null,
              humanCapability: null,
            },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          });
        case "propose-assumption":
          return response({
            id: "assumption-id-1",
            number: 1,
            handle: "A1",
            elementId: null,
            text: "SQLite remains authoritative.",
            recordVersion: 1,
            disposition: "proposed",
            disposedAt: null,
            withdrawnAt: null,
            proposedBy: null,
            supersedesHandle: null,
            supersededByHandle: null,
            currentDraftCitations: null,
            presentation: {
              state: "current",
              attentionActive: true,
              lastMutation: null,
              humanCapability: { kind: "dispose", allowed: true },
            },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          });
        case "open-question":
          return response({
            ...handle("Q2"),
            id: "question-id-2",
            number: 2,
            elementId: "task-id-1",
            text: "Which retention period applies?\n",
            recordVersion: 1,
            status: "open",
            answer: null,
            answeredAt: null,
            withdrawnAt: null,
            provenance: null,
            presentation: {
              state: "current",
              attentionActive: true,
              lastMutation: null,
              humanCapability: { kind: "answer", allowed: true },
            },
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          });
        case "edit-attention":
          return response(
            options.citedAttentionReceipt
              ? {
                  operation: "edited",
                  recordKind: "assumption",
                  recordId: "assumption-id-1",
                  recordHandle: "A1",
                  previousRecordVersion: 1,
                  newRecordVersion: 2,
                  lifecycle: "proposed",
                  draftRevisionId: "revision-draft",
                  previousCitationVersion: 2,
                  newCitationVersion: 3,
                  citationChanges: {
                    added: [],
                    removed: [],
                    refreshed: ["R1"],
                  },
                  idempotentReplay: false,
                }
              : {
                  operation: "edited",
                  recordKind: "question",
                  recordId: "question-id-1",
                  recordHandle: "Q1",
                  previousRecordVersion: 3,
                  newRecordVersion: 4,
                  lifecycle: "open",
                  draftRevisionId: null,
                  previousCitationVersion: null,
                  newCitationVersion: null,
                  citationChanges: { added: [], removed: [], refreshed: [] },
                  idempotentReplay: false,
                },
          );
        case "supersede-assumption":
          return response({
            operation: "superseded",
            recordKind: "assumption",
            recordId: "assumption-id-1",
            recordHandle: "A1",
            previousRecordVersion: 4,
            newRecordVersion: 4,
            lifecycle: "confirmed",
            draftRevisionId: "revision-original",
            previousCitationVersion: 6,
            newCitationVersion: 6,
            citationChanges: { added: [], removed: [], refreshed: [] },
            successor: { id: "assumption-id-2", handle: "A2" },
            idempotentReplay: true,
          });
        case "request-approval": {
          // The server, not the CLI, decides the scope: an omitted subject is
          // the whole-gate ask and carries no element.
          const posted = z
            .object({ subject: z.string().optional() })
            .safeParse(JSON.parse(init.body ?? "{}"));
          const named = posted.success ? posted.data.subject : undefined;
          return response({
            attentionId: "attention-1",
            revisionId: "revision-draft",
            gate: "requirements",
            subject: named ?? "requirements",
            scope: named === undefined ? "gate" : "item",
            alreadyRequested: options.alreadyRequested === true,
            elementId: named === undefined ? null : "requirement-id-1",
            outstandingSubjects: ["R1", "R2"],
            signOffOutstanding: true,
            deliveryOutcome:
              options.deliveryUncertain === true
                ? "delivery-uncertain"
                : "delivered",
          });
        }
        case "start-execution":
          if (options.startBody !== undefined) {
            return response(
              options.startBody.body,
              options.startBody.status ?? 200,
            );
          }
          return response({
            execution: {
              id: "execution-1",
              specId: spec.id,
              revisionId: "revision-approved",
              revisionNumber: 1,
              scope: null,
              state: "definition_review",
              workflowSeedSource: {
                kind: "spec_delivery",
                specSlug: "native-sdd",
                candidateId: "launch-1",
              },
              workflowExecutionId: null,
              sessionName: "feature-session",
              deliveredAt: null,
              abandonedReason: null,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
            workflowDefinition: {
              id: "candidate-1",
              revision: 4,
            },
            deliveryPlan: {
              attemptId: "attempt-1",
              candidateId: "candidate-1",
              candidateHash: "sha256:candidate",
              workflowExecutionId: "workflow-execution-1",
              resolvedDefinitionHash: `sha256:${"d".repeat(64)}`,
            },
          });
        case "open-amendment":
          return response({
            revision: {
              ...revision(),
              id: "revision-amendment",
              number: options.skippedWithdrawn === true ? 3 : 2,
              authoringStage: "plan",
              basedOnRevisionId: "revision-approved",
            },
            skippedWithdrawnRevisions:
              options.skippedWithdrawn === true
                ? [
                    {
                      ...revision(),
                      id: "revision-withdrawn",
                      number: 2,
                      state: "withdrawn",
                      authoringStage: "plan",
                      basedOnRevisionId: "revision-approved",
                    },
                  ]
                : [],
          });
        case "withdraw-proposal":
          return response({
            withdrawn: {
              ...revision(),
              id: "revision-proposed",
              number: 2,
              state: "withdrawn",
              authoringStage: "plan",
            },
            draft: {
              ...revision(),
              id: "revision-follow-up",
              number: 3,
              authoringStage: "plan",
              basedOnRevisionId: "revision-proposed",
            },
            // Computed against the reopened draft: what the withdrawal cost is
            // exactly what the ledger of the draft that now exists says.
            approvalLedger,
          });
        case "abandon-spec":
          return response({
            ...spec,
            abandonedAt: CREATED_AT,
            abandonedReason: "Superseded",
          });
        case "abandon-execution":
          return response({
            id: "execution-1",
            spec_id: spec.id,
            revision_id: "revision-approved",
            scope_json: "{}",
            state: "abandoned",
            execution_start_dial: "gate",
            workflow_definition_id: "workflow-1",
            workflow_definition_revision: 1,
            workflow_execution_id: "workflow-execution-1",
            session_name: "feature-session",
            delivered_at: null,
            abandoned_reason: "Superseded",
            cleanup_phase: null,
            linked_workflow_execution_id: "workflow-execution-1",
            cleanup_last_error: null,
            cleanup_last_error_at: null,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          });
        case "capture-scope-amendment": {
          const body: unknown = JSON.parse(init.body ?? "{}");
          const blocking =
            typeof body === "object" &&
            body !== null &&
            "blockingReason" in body;
          return response({
            discovery: {
              id: "discovery-1",
              executionId: "execution-1",
              workflowExecutionId: "workflow-execution-1",
              attemptId: "attempt-1",
              title: "Handle the discovered migration",
            },
            restartRequired: blocking,
            replacement: blocking
              ? {
                  abandonedExecutionId: "execution-1",
                  abandonedWorkflowExecutionId: "workflow-execution-1",
                  replacementAttemptId: "attempt-2",
                }
              : null,
          });
        }
        default:
          return response({ ok: true });
      }
    },
    async readTextFile(filePath) {
      return (
        options.files?.[filePath] ?? (filePath === INPUTS_FILE ? "{}" : null)
      );
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

function actionRequests(host: { requests: RecordedRequest[] }) {
  return host.requests.filter((request) => request.init.method === "POST");
}

// The create document: the spec's first revision has no element version to
// compare against, so it states none.
const FIRST_ELEMENT_ADDRESS = {
  elementId: "requirement-id-1",
  kind: "requirement",
  parentElementId: null,
  position: 0,
  payload: {
    kind: "requirement",
    statement: "Candidate content",
    priority: "must",
    risk: "high",
  },
};
// The draft document: the same element, plus the compare-and-swap version the
// author last read. `null` creates the element.
const DRAFT_ELEMENT = { ...FIRST_ELEMENT_ADDRESS, baseElementVersion: null };
const DRAFT_FILE_CONTENT = JSON.stringify(DRAFT_ELEMENT);

// A batch document: an array of element writes, each carrying its OWN
// baseElementVersion — the concurrency boundary stays per element.
const BATCH_ELEMENTS = [
  {
    elementId: "requirement-id-1",
    kind: "requirement",
    parentElementId: null,
    position: 0,
    payload: REQUIREMENT_PAYLOAD,
    baseElementVersion: 3,
  },
  {
    elementId: "criterion-id-1",
    kind: "criterion",
    parentElementId: "requirement-id-1",
    payload: CRITERION_PAYLOAD,
    baseElementVersion: null,
  },
];
const BATCH_FILE_CONTENT = JSON.stringify(BATCH_ELEMENTS);

// The keyed batch document: writes and removals in one transaction, because a
// reference and its target can only leave together. Removals are addressed by
// element id and the version they take out — the file contract carries no
// handle form, which is the server's own removal schema.
const BATCH_REMOVALS = [{ elementId: "task-id-1", baseElementVersion: 2 }];
const BATCH_DOCUMENT_FILE_CONTENT = JSON.stringify({
  elements: BATCH_ELEMENTS,
  removals: BATCH_REMOVALS,
});
const REMOVALS_ONLY_FILE_CONTENT = JSON.stringify({
  removals: BATCH_REMOVALS,
});
const DISCOVERED_TASK_FILE_CONTENT = JSON.stringify({
  title: "Handle the discovered migration",
  instructions: "Write the follow-up migration.",
  tracedRequirementElementIds: ["requirement-id-1"],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: ["criterion-id-1"],
  dependsOnTaskElementIds: [],
});

describe("cctl spec write verbs", () => {
  it("reports the deterministic lint delta without making enrichment decide write success", async () => {
    for (const unavailable of [false, true]) {
      const host = makeHost({
        files: { [BATCH_FILE]: BATCH_FILE_CONTENT },
        blockingCounts: [2, 0],
        lintUnavailable: unavailable,
      });
      const result = await runCcWithHost(
        ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
        baseEnv,
        host,
      );
      expect(result.exitCode, result.stdout).toBe(0);
      if (unavailable) expect(inlineDataOf(result)).not.toHaveProperty("lint");
      else
        expect(inlineDataOf(result)).toMatchObject({
          lint: { blockingBefore: 2, blockingAfter: 0 },
        });
      expect(actionRequests(host)).toHaveLength(1);
    }
  });

  it.each([
    { gate: "requirements", outcome: "filed", attentionId: "attention-1" },
    {
      gate: "requirements",
      outcome: "already-filed",
      attentionId: "attention-1",
    },
    { gate: "requirements", outcome: "not-needed", attentionId: null },
    { gate: "requirements", outcome: "not-filed", attentionId: null },
    {
      gate: "requirements",
      outcome: "delivery-uncertain",
      attentionId: "attention-1",
    },
  ] as const)(
    "keeps the $outcome approval outcome and human pending block on an applied proposal",
    async (request) => {
      const result = await runCcWithHost(
        ["spec", "propose", "native-sdd", "--json"],
        baseEnv,
        makeHost({ proposeApprovalRequests: [request], importCarried: true }),
      );
      expect(result.exitCode, result.stdout).toBe(0);
      expect(inlineDataOf(result)).toMatchObject({
        revision: { state: "proposed", authoringStage: "plan" },
        approvalRequests: [request],
        pendingBlock: { actsNext: "human" },
        approvalLedger: {
          satisfied: 1,
          pending: 1,
          importSettled: 1,
          carried: 0,
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        instruction: expect.stringContaining("human"),
      });
    },
  );

  it("distinguishes a proposal that absorbed sign-off from an outstanding human review", async () => {
    const result = await runCcWithHost(
      ["spec", "propose", "native-sdd", "--json"],
      baseEnv,
      makeHost({ absorbedSignOff: true }),
    );
    expect(result.exitCode).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      revision: { state: "approved" },
      absorbedSignOff: true,
      pendingBlock: null,
      approvalRequests: [{ outcome: "not-needed", attentionId: null }],
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("instruction");
  });

  it.each([
    {
      refusal: "answer-question",
      args: ["answer", "native-sdd/Q1", "--answer", "Use seven days."],
    },
    {
      refusal: "rename",
      args: ["rename", "native-sdd", "--to", "renamed-spec"],
    },
    {
      refusal: "abandon-spec",
      args: ["abandon", "native-sdd", "--reason", "Superseded"],
    },
  ] as const)(
    "preserves the authenticated human-only $refusal instruction",
    async ({ refusal, args }) => {
      const result = await runCcWithHost(
        ["spec", ...args, "--json"],
        baseEnv,
        makeHost({ refusal }),
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "not_applied",
        error: { details: { serverCode: "human_act_required" } },
        instruction: expect.any(String),
      });
      expect(JSON.parse(result.stdout).instruction.length).toBeGreaterThan(0);
    },
  );

  it("preserves prelaunch capture refusal and the direct graph-authoring remedy", async () => {
    const result = await runCcWithHost(
      ["spec", "capture", "native-sdd", "--file", TASK_FILE, "--json"],
      baseEnv,
      makeHost({
        files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
        refusal: "capture-scope-amendment",
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: { details: { serverCode: "gate_blocked" } },
      instruction: expect.stringContaining("cctl workflow replace"),
    });
  });

  it("keeps authored refusal fields from forging protocol guidance lines", async () => {
    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      makeHost({
        files: { [BATCH_FILE]: BATCH_FILE_CONTENT },
        refusal: "draft-batch",
        unsafeBatchGuidance: true,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toMatch(/^why: forged|^instruction: forged/m);
    expect(result.stderr).toContain("nothing was written");
  });

  it("replies to a review thread and reports a typed receipt", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "reply",
        "native-sdd",
        "--thread",
        "thread-1",
        "--body",
        "Answered in place.",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);

    const post = host.requests.find(
      (request) => request.init.method === "POST",
    );
    expect(new URL(post?.url ?? "http://unset/").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/reply",
    );
    expect(JSON.parse(post?.init.body ?? "{}")).toEqual({
      threadId: "thread-1",
      body: "Answered in place.",
    });

    const data = await runCcWithHost(
      [
        "spec",
        "reply",
        "native-sdd",
        "--thread",
        "thread-1",
        "--body",
        "Answered in place.",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(data.exitCode).toBe(0);
    const envelope = inlineDataOf(data);
    // The receipt is the projected comment view, never the raw row.
    expect(envelope).toMatchObject({
      threadId: "thread-1",
      parentCommentId: "comment-root-1",
      body: "Answered in place.",
      blocking: false,
      resolution: "open",
      author: { kind: "agent", conversationId: "conversation-1" },
    });
    expect(Object.keys(envelope)).not.toContain("anchor_json");
  });

  it("edits attention through record CAS without echoing authored content", async () => {
    const host = makeHost({
      files: {
        ".cc/temp/question-update.json": JSON.stringify({
          kind: "question",
          text: "Which workloads are in scope?",
        }),
      },
    });
    const result = await runCcWithHost(
      [
        "spec",
        "attention",
        "edit",
        "native-sdd",
        "Q1",
        "--file",
        ".cc/temp/question-update.json",
        "--if-version",
        "3",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const post = host.requests.find(
      (request) => request.init.method === "POST",
    );
    expect(new URL(post?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/edit-attention",
    );
    expect(JSON.parse(post?.init.body ?? "null")).toEqual({
      recordId: "question-id-1",
      expectedRecordVersion: 3,
      payload: {
        kind: "question",
        text: "Which workloads are in scope?",
      },
    });
    expect(inlineDataOf(result)).toMatchObject({
      recordHandle: "Q1",
      previousRecordVersion: 3,
      newRecordVersion: 4,
    });
  });

  it.each(["no-draft", "uncited"] as const)(
    "allows an attachment-preserve edit without citation CAS when the assumption is %s",
    async (assumptionCitationState) => {
      const host = makeHost({
        assumptionCitationState,
        files: {
          ".cc/temp/assumption-update.json": JSON.stringify({
            kind: "assumption",
            attachment: { kind: "element", handle: "R1" },
            citationIntent: { kind: "preserve" },
          }),
        },
      });
      const result = await runCcWithHost(
        [
          "spec",
          "attention",
          "edit",
          "native-sdd",
          "A1",
          "--file",
          ".cc/temp/assumption-update.json",
          "--if-version",
          "1",
          "--json",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "null")).toEqual({
        recordId: "assumption-id-1",
        expectedRecordVersion: 1,
        payload: {
          kind: "assumption",
          attachment: { kind: "element", handle: "R1" },
          citationIntent: { kind: "preserve" },
        },
      });
    },
  );

  it("refuses a cited assumption withdrawal without citation CAS before POST", async () => {
    const host = makeHost({
      assumptionCitationState: "cited",
      files: { ".cc/temp/reason.md": "The premise is obsolete.\n" },
    });
    const result = await runCcWithHost(
      [
        "spec",
        "attention",
        "withdraw",
        "native-sdd",
        "A1",
        "--reason-file",
        ".cc/temp/reason.md",
        "--if-version",
        "1",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--if-citation-version");
    expect(actionRequests(host)).toHaveLength(0);
  });

  it("renders the receipt's previous and new record and citation versions", async () => {
    const host = makeHost({
      assumptionCitationState: "cited",
      citedAttentionReceipt: true,
      files: {
        ".cc/temp/assumption-update.json": JSON.stringify({
          kind: "assumption",
          text: "SQLite remains the durable authority.",
        }),
      },
    });
    const result = await runCcWithHost(
      [
        "spec",
        "attention",
        "edit",
        "native-sdd",
        "A1",
        "--file",
        ".cc/temp/assumption-update.json",
        "--if-version",
        "1",
        "--if-citation-version",
        "2",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);

    const json = await runCcWithHost(
      [
        "spec",
        "attention",
        "edit",
        "native-sdd",
        "A1",
        "--file",
        ".cc/temp/assumption-update.json",
        "--if-version",
        "1",
        "--if-citation-version",
        "2",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(inlineDataOf(json)).toMatchObject({
      previousRecordVersion: 1,
      newRecordVersion: 2,
      previousCitationVersion: 2,
      newCitationVersion: 3,
    });
  });

  it.each(["no-draft", "cited"] as const)(
    "resubmits a supersession operation without retargeting its %s replacement state",
    async (assumptionCitationState) => {
      const payload = {
        operationId: "supersede-operation",
        reason: "The premise needed correction.",
        text: "SQLite remains authoritative under a pinned revision.",
        attachment: { kind: "spec" },
        citations: { kind: "clear" },
      };
      const host = makeHost({
        assumptionCitationState,
        assumptionSuperseded: true,
        files: {
          ".cc/temp/successor.json": JSON.stringify(payload),
        },
      });
      const result = await runCcWithHost(
        [
          "spec",
          "attention",
          "supersede",
          "native-sdd",
          "A1",
          "--file",
          ".cc/temp/successor.json",
          "--if-version",
          "3",
          "--if-citation-version",
          "5",
          "--json",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      const post = actionRequests(host)[0];
      expect(new URL(post?.url ?? "").pathname).toBe(
        "/api/specs/demo/native-sdd/actions/supersede-assumption",
      );
      expect(JSON.parse(post?.init.body ?? "null")).toEqual({
        assumptionId: "assumption-id-1",
        expectedRecordVersion: 3,
        expectedCitationVersion: 5,
        payload,
      });
      expect(inlineDataOf(result)).toMatchObject({
        successor: { handle: "A2" },
        idempotentReplay: true,
      });
    },
  );

  it("opens an amendment draft on an approved spec through its own verb", async () => {
    const host = makeHost({ approved: true });
    const result = await runCcWithHost(
      ["spec", "amend", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const request = actionRequests(host)[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/open-amendment",
    );
    // The action body is strict: any extra key is a 400.
    expect(JSON.parse(request?.init.body ?? "null")).toEqual({});
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    expect(inlineDataOf(result)).toMatchObject({
      revision: { id: "revision-amendment", number: 2, authoringStage: "plan" },
    });
  });

  /**
   * A withdrawn revision is terminal, so the amendment cannot carry it and
   * cannot refuse over it. The one remaining option is saying so.
   */
  it("names the withdrawn revision the amendment leaves behind, in text and JSON", async () => {
    const text = await runCcWithHost(
      ["spec", "amend", "native-sdd"],
      baseEnv,
      makeHost({ approved: true, skippedWithdrawn: true }),
    );

    expect(text.exitCode).toBe(0);

    const json = await runCcWithHost(
      ["spec", "amend", "native-sdd", "--json"],
      baseEnv,
      makeHost({ approved: true, skippedWithdrawn: true }),
    );

    expect(json.exitCode).toBe(0);
    expect(inlineDataOf(json)).toMatchObject({
      revision: { id: "revision-amendment", number: 3 },
      skippedWithdrawnRevisions: [{ id: "revision-withdrawn", number: 2 }],
    });
  });

  it("renders the revision_in_review refusal when an amendment would fork past a review", async () => {
    const host = makeHost({ approved: true, refusal: "open-amendment" });

    const text = await runCcWithHost(
      ["spec", "amend", "native-sdd"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("Revision 2");
    expect(text.stderr).toContain(
      `instruction: ${REVISION_IN_REVIEW_INSTRUCTION}`,
    );
    // The agent-side exit is one of the three recoveries the server teaches,
    // so a rendering that drops it leaves the agent waiting on a human.
    expect(text.stderr).toContain("cctl spec withdraw-proposal");

    const json = await runCcWithHost(
      ["spec", "amend", "native-sdd", "--json"],
      baseEnv,
      makeHost({ approved: true, refusal: "open-amendment" }),
    );

    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      instruction: expect.stringContaining("sign off revision 2"),
      error: {
        details: {
          serverCode: "revision_in_review",
          serverDetails: { proposals: [{ id: "revision-2", number: 2 }] },
        },
      },
    });
  });

  it("withdraws the caller's own proposal and names the draft it reopened", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "withdraw-proposal",
        "native-sdd",
        "--revision",
        "revision-proposed",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const request = actionRequests(host)[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/withdraw-proposal",
    );
    // The token travels exactly as given: the CLI never substitutes the
    // server's current proposal for the one the caller named.
    expect(JSON.parse(request?.init.body ?? "null")).toEqual({
      revisionId: "revision-proposed",
    });
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    expect(inlineDataOf(result)).toMatchObject({
      withdrawn: { id: "revision-proposed", state: "withdrawn" },
      draft: { id: "revision-follow-up", number: 3 },
    });

    const text = await runCcWithHost(
      [
        "spec",
        "withdraw-proposal",
        "native-sdd",
        "--revision",
        "revision-proposed",
      ],
      baseEnv,
      makeHost(),
    );
    expect(text.exitCode).toBe(0);
  });

  it("opens a question with a resolved element attachment", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "question",
        "native-sdd",
        "--text",
        "Which retention period applies?",
        "--element",
        "T1",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({ number: 2, status: "open" });
    const post = actionRequests(host)[0];
    expect(new URL(post?.url ?? "").pathname.endsWith("/open-question")).toBe(
      true,
    );
    expect(JSON.parse(post?.init.body ?? "{}")).toEqual({
      elementId: "task-id-1",
      text: "Which retention period applies?",
    });
  });

  it("names the missing spec slug for a well-formed but unqualified handle", async () => {
    const host = makeHost();
    const answer = await runCcWithHost(
      ["spec", "answer", "Q2", "--answer", "The full scope."],
      baseEnv,
      host,
    );
    expect(answer.exitCode).toBe(2);
    expect(answer.stderr).toContain("qualified question handle");
    // Q2 is a valid question handle, so the grammar refusal would be false,
    // and this command cannot honor "optionally qualify".
    expect(answer.stderr).not.toContain("not a valid element handle");
    expect(answer.stderr).not.toContain("Optionally qualify");

    expect(host.requests).toHaveLength(0);
  });

  it("answers against the question record version returned by status", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "answer", "native-sdd/Q1", "--answer", "The full scope."],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const post = actionRequests(host)[0];
    expect(JSON.parse(post?.init.body ?? "null")).toEqual({
      questionId: "question-id-1",
      recordVersion: 3,
      answer: "The full scope.",
    });
  });

  it("names the wrong element kind for a qualified handle this command cannot take", async () => {
    const host = makeHost();
    const answer = await runCcWithHost(
      ["spec", "answer", "native-sdd/T7", "--answer", "The full scope."],
      baseEnv,
      host,
    );

    expect(answer.exitCode).toBe(2);
    expect(answer.stderr).toContain("must address a question");
    expect(host.requests).toHaveLength(0);
  });

  it("keeps the grammar refusal for an ungrammatical target and names the qualified form", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "answer", "native-sdd/question_7", "--answer", "The scope."],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid element handle");

    expect(host.requests).toHaveLength(0);
  });

  it("rejects Q and A handles as question/assumption attachment targets before network", async () => {
    const host = makeHost();
    for (const argv of [
      ["spec", "question", "native-sdd", "--text", "x", "--element", "Q1"],
      ["spec", "assume", "native-sdd", "--text", "x", "--element", "A1"],
    ]) {
      const result = await runCcWithHost(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "requirement, criterion, decision, or task",
      );
    }
    expect(host.requests).toHaveLength(0);
  });

  it("sends base-versioned draft writes and surfaces current content on conflict", async () => {
    const elementFile = JSON.stringify({
      ...FIRST_ELEMENT_ADDRESS,
      baseElementVersion: 1,
    });
    const host = makeHost({
      files: { [SPEC_FILE]: elementFile },
      refusal: "draft-upsert",
    });
    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", SPEC_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        details: {
          serverCode: "stale_element",
          serverDetails: {
            currentContent: { statement: "Winning content" },
            currentVersion: 2,
          },
        },
      },
    });
    const request = actionRequests(host)[0];
    expect(JSON.parse(request?.init.body ?? "{}")).toMatchObject({
      revisionId: "revision-draft",
      baseElementVersion: 1,
      elementId: "requirement-id-1",
    });
  });

  /**
   * The single-element form and the batch form are the same document, so one
   * schema parses both and neither can accept a shape the other refuses. A
   * one-element array and a lone object therefore describe the same write, and
   * the element the server receives is identical either way.
   */
  it("normalizes the single and batch draft forms to the same element document", async () => {
    const single = makeHost({ files: { [DRAFT_FILE]: DRAFT_FILE_CONTENT } });
    const asBatch = makeHost({
      files: { [DRAFT_FILE]: JSON.stringify([DRAFT_ELEMENT]) },
    });

    const one = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", DRAFT_FILE],
      baseEnv,
      single,
    );
    const batched = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", DRAFT_FILE],
      baseEnv,
      asBatch,
    );

    expect(one.exitCode).toBe(0);
    expect(batched.exitCode).toBe(0);
    // The element travels verbatim in both forms; only the reporting shape
    // the server owes back differs, so only the envelope around it differs.
    expect(JSON.parse(actionRequests(single)[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      ...DRAFT_ELEMENT,
    });
    expect(JSON.parse(actionRequests(asBatch)[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      elements: [DRAFT_ELEMENT],
    });
  });

  /**
   * The create document and the draft document are different shapes: a spec's
   * first revision has no element version to compare against. An explicit
   * `baseElementVersion: null` states exactly that and is tolerated (#60 —
   * refusing it was a guaranteed first-contact stumble); a NUMBER is still a
   * draft document sent at the wrong verb.
   */
  it("tolerates an explicit-null base version on create and refuses a numeric one", async () => {
    const createArgs = [
      "spec",
      "create",
      "--slug",
      "native-sdd",
      "--name",
      "Native SDD",
      "--preset",
      "contract-bearing",
      "--file",
      SPEC_FILE,
    ];
    const nullHost = makeHost({ files: { [SPEC_FILE]: DRAFT_FILE_CONTENT } });
    const tolerated = await runCcWithHost(createArgs, baseEnv, nullHost);
    expect(tolerated.exitCode).toBe(0);
    expect(
      nullHost.requests.some((request) =>
        new URL(request.url).pathname.endsWith("/actions/create"),
      ),
    ).toBe(true);

    const numericHost = makeHost({
      files: {
        [SPEC_FILE]: JSON.stringify({
          ...DRAFT_ELEMENT,
          baseElementVersion: 3,
        }),
      },
    });
    const refused = await runCcWithHost(createArgs, baseEnv, numericHost);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("baseElementVersion");
    expect(numericHost.requests).toHaveLength(0);
  });

  it("submits an array --file as one batch and reports each element by its index", async () => {
    const host = makeHost({ files: { [BATCH_FILE]: BATCH_FILE_CONTENT } });
    const text = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // One transaction, one request — a batch is not N single writes.
    const actions = actionRequests(host);
    expect(actions).toHaveLength(2);
    expect(new URL(actions[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/draft-batch",
    );
    // Per-element baseElementVersion travels verbatim: the CAS boundary is the
    // element, never the revision.
    expect(JSON.parse(actions[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      elements: BATCH_ELEMENTS,
    });

    expect(structured.exitCode).toBe(0);
    expect(inlineDataOf(structured)).toMatchObject({
      revisionId: "revision-draft",
      written: [
        { index: 0, elementId: "requirement-id-1", handle: "R1" },
        { index: 1, elementId: "criterion-id-1", handle: "R1.1" },
      ],
    });
  });

  it("bounds the receipt to identities under --quiet", async () => {
    const host = makeHost({ files: { [BATCH_FILE]: BATCH_FILE_CONTENT } });
    const batch = await runCcWithHost(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        BATCH_FILE,
        "--quiet",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(batch.exitCode).toBe(0);
    const envelope = z
      .object({ written: z.array(z.record(z.string(), z.unknown())) })
      .passthrough()
      .parse(inlineDataOf(batch));
    // Identities only: a 52-element batch receipt must not echo every payload
    // back through the pipe cap.
    expect(envelope).toMatchObject({
      revisionId: "revision-draft",
      written: [
        {
          index: 0,
          elementId: "requirement-id-1",
          handle: "R1",
          elementVersion: 4,
        },
        {
          index: 1,
          elementId: "criterion-id-1",
          handle: "R1.1",
          elementVersion: 1,
        },
      ],
    });
    for (const entry of envelope.written) {
      expect(Object.keys(entry)).not.toContain("element");
      expect(Object.keys(entry)).not.toContain("version");
    }

    const single = await runCcWithHost(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        DRAFT_FILE,
        "--quiet",
        "--json",
      ],
      baseEnv,
      makeHost({ files: { [DRAFT_FILE]: DRAFT_FILE_CONTENT } }),
    );
    expect(single.exitCode).toBe(0);
    const singleEnvelope =
      z
        .object({ written: z.array(z.record(z.string(), z.unknown())) })
        .parse(inlineDataOf(single)).written[0] ?? {};
    expect(singleEnvelope).toMatchObject({ handle: "T1" });
    expect(Object.keys(singleEnvelope)).not.toContain("element");
    expect(Object.keys(singleEnvelope)).not.toContain("version");
  });

  it("names every element that refused a batch, by index, in text and json", async () => {
    const host = makeHost({
      files: { [BATCH_FILE]: BATCH_FILE_CONTENT },
      refusal: "draft-batch",
    });
    const text = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("requirement-id-1");
    expect(text.stderr).toContain("criterion-id-1");
    expect(text.stderr).toContain("nothing was written");

    expect(structured.exitCode).toBe(1);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: false,
      error: {
        details: {
          serverCode: "stale_element",
          serverDetails: {
            refusals: [
              {
                input: "element",
                index: 0,
                elementId: "requirement-id-1",
                code: "stale_element",
                currentElementVersion: 4,
              },
              {
                input: "element",
                index: 1,
                elementId: "criterion-id-1",
                code: "parent_immutable",
                currentElementVersion: null,
                rationale:
                  "containment is identity: a moved element would retroactively change what every frozen revision contained",
                details: {
                  currentParentElementId: "requirement-id-1",
                  requestedParentElementId: "requirement-id-2",
                },
              },
            ],
          },
        },
      },
    });
  });

  it("preserves the refusal and global recovery when optional item recovery is absent", async () => {
    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
      baseEnv,
      makeHost({
        files: { [BATCH_FILE]: BATCH_FILE_CONTENT },
        refusal: "draft-batch",
        omitBatchInstruction: true,
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { details: { serverCode: "stale_element" } },
    });
  });

  it("submits writes and removals from one keyed document as a single batch", async () => {
    const host = makeHost({
      files: { [BATCH_FILE]: BATCH_DOCUMENT_FILE_CONTENT },
    });

    const text = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    const actions = actionRequests(host);
    // A write and the removal it depends on land in ONE transaction: two
    // requests would have no legal order.
    expect(actions).toHaveLength(2);
    expect(new URL(actions[0]?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/draft-batch",
    );
    expect(JSON.parse(actions[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      elements: BATCH_ELEMENTS,
      removals: BATCH_REMOVALS,
    });

    // Undo is named at the moment it becomes relevant, not left to be
    // rediscovered from the schema docs.

    expect(structured.exitCode).toBe(0);
    expect(inlineDataOf(structured)).toMatchObject({
      revisionId: "revision-draft",
      removals: BATCH_REMOVALS,
    });
  });

  it("accepts a keyed document that only removes", async () => {
    const host = makeHost({
      files: { [BATCH_FILE]: REMOVALS_ONLY_FILE_CONTENT },
    });

    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      elements: [],
      removals: BATCH_REMOVALS,
    });
  });

  it("refuses a batch element that omits its own baseElementVersion", async () => {
    const host = makeHost({
      files: {
        [BATCH_FILE]: JSON.stringify([
          {
            elementId: "requirement-id-1",
            kind: "requirement",
            parentElementId: null,
            payload: REQUIREMENT_PAYLOAD,
          },
        ]),
      },
    });
    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("baseElementVersion");
    expect(host.requests).toHaveLength(0);
  });

  it("resolves a draft write's target revision from the edit-context read alone", async () => {
    const host = makeHost({ files: { [DRAFT_FILE]: DRAFT_FILE_CONTENT } });
    const result = await runCcWithHost(
      ["spec", "draft", "native-sdd", "--file", DRAFT_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    // Pinned as exact paths: a regression to the full spec GET would transfer
    // the whole document once per saved element. The two lint reads are the
    // blocking-count delta's own — findings only, on either side of the write.
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/lint",
      "/api/specs/demo/native-sdd/actions/draft-upsert",
      "/api/specs/demo/native-sdd/lint",
    ]);
  });

  it("resolves an execution's pinned revision from the edit-context read alone", async () => {
    const host = makeHost({ approved: true });
    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", INPUTS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/actions/start-execution",
    ]);
    expect(
      JSON.parse(actionRequests(host)[0]?.init.body ?? "{}").revisionId,
    ).toBe("revision-approved");
  });

  it("resolves every handle spec remove names before submitting one batch", async () => {
    const host = makeHost();

    const text = await runCcWithHost(
      ["spec", "remove", "native-sdd", "R1.1", "T1"],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "remove", "native-sdd", "R1.1", "T1", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // Handles are resolved client-side against the write path's own read, so
    // the file contract and the verb submit the identical removal document.
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/actions/draft-batch",
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/actions/draft-batch",
    ]);
    expect(
      host.requests
        .filter(({ init }) => init.method === "GET")
        .filter(({ url }) => !new URL(url).pathname.endsWith("/lint"))
        .map(({ url }) => new URL(url).searchParams.get("element")),
    ).toEqual(["R1.1", "T1", "R1.1", "T1"]);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      elements: [],
      removals: [
        { elementId: "criterion-id-1", baseElementVersion: 1 },
        { elementId: "task-id-1", baseElementVersion: 2 },
      ],
    });

    expect(structured.exitCode).toBe(0);
    expect(inlineDataOf(structured)).toMatchObject({
      removed: [
        { elementId: "criterion-id-1", handle: "R1.1" },
        { elementId: "task-id-1", handle: "T1" },
      ],
    });
  });

  it("refuses spec remove before any write when a handle is not in the draft", async () => {
    const host = makeHost();

    const result = await runCcWithHost(
      ["spec", "remove", "native-sdd", "R1.1", "T9"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("T9");
    expect(actionRequests(host)).toHaveLength(0);
  });

  it("advances the exact current draft and expected authoring stage", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      ["spec", "advance", "native-sdd", "--from", "requirements", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      revision: { id: "revision-draft", authoringStage: "design" },
    });
    const request = actionRequests(host).find(({ url }) =>
      url.endsWith("/actions/advance"),
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      revisionId: "revision-draft",
      expectedStage: "requirements",
    });
  });

  it("returns the exact Design draft to a Requirements checkpoint", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "return-to-requirements",
        "native-sdd",
        "--reason",
        "Requirements changed",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(inlineDataOf(result)).toMatchObject({
      revision: {
        id: "revision-requirements-return",
        authoringStage: "requirements",
      },
      withdrawnRevision: { id: "revision-design-withdrawn" },
    });
    const request = actionRequests(host).find(({ url }) =>
      url.endsWith("/actions/return-to-requirements"),
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      expectedRevisionId: "revision-draft",
      reason: "Requirements changed",
    });
  });

  it("retains every failed cumulative approval request for recovery", async () => {
    const approvalRequests: SpecProposeApprovalRequest[] = [
      { gate: "requirements", outcome: "not-filed", attentionId: null },
      {
        gate: "plan",
        outcome: "delivery-uncertain",
        attentionId: "attention-plan",
      },
    ];
    const text = await runCcWithHost(
      ["spec", "propose", "native-sdd"],
      baseEnv,
      makeHost({ proposeApprovalRequests: approvalRequests }),
    );
    const structured = await runCcWithHost(
      ["spec", "propose", "native-sdd", "--json"],
      baseEnv,
      makeHost({ proposeApprovalRequests: approvalRequests }),
    );

    expect(text.exitCode).toBe(0);

    expect(structured.exitCode).toBe(0);
    expect(inlineDataOf(structured)).toMatchObject({ approvalRequests });
    expect(text.stdout).toContain(
      "request notification repair owed: requirements, plan",
    );
  });

  it("sends the notes document the propose was given", async () => {
    const notes = "## Disposition\n\nClosed F3 by rebinding the loop exit.\n";
    const host = makeHost();

    const result = await runCcWithHost(
      ["spec", "propose", "native-sdd", "--notes", notes],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const propose = actionRequests(host).find((request) =>
      request.url.endsWith("/propose"),
    );
    expect(JSON.parse(String(propose?.init.body))).toEqual({
      revisionId: "revision-draft",
      notes,
    });
  });

  it("sends an omitted --subject as an omission for the server to resolve", async () => {
    const host = makeHost();
    await runCcWithHost(
      ["spec", "request-approval", "native-sdd", "--gate", "requirements"],
      baseEnv,
      host,
    );

    const request = host.requests.find(({ url }) =>
      url.includes("request-approval"),
    );
    if (request?.init.body === undefined) {
      throw new Error("no request-approval body was sent");
    }
    const body: unknown = JSON.parse(request.init.body);
    // A locally substituted subject would file an item request the sign-off
    // cannot clear; the omission is what asks for the gate itself.
    expect(body).toEqual({
      revisionId: "revision-draft",
      gate: "requirements",
    });
  });

  it("says an approval ask that was already open created no second request", async () => {
    const result = await runCcWithHost(
      [
        "spec",
        "request-approval",
        "native-sdd",
        "--gate",
        "requirements",
        "--json",
      ],
      baseEnv,
      makeHost({ alreadyRequested: true }),
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const envelope = inlineDataOf(result);
    // A repeat must not read as a second Needs You entry, or an agent that
    // re-asks will believe it escalated when nothing changed.
    expect(envelope.alreadyRequested).toBe(true);

    expect(envelope).toMatchObject({
      alreadyRequested: true,
      scope: "gate",
      subject: "requirements",
      elementId: null,
      deliveryOutcome: "delivered",
    });
    expect(JSON.parse(result.stdout).recovery).toMatchObject({
      references: [{ kind: "approval-request", id: "attention-1" }],
    });
  });

  it("names the undelivered notice and the re-fire when delivery is uncertain", async () => {
    const host = makeHost({ deliveryUncertain: true });

    const text = await runCcWithHost(
      ["spec", "request-approval", "native-sdd", "--gate", "requirements"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    // The ask committed, so reporting a failure would be false; what is
    // uncertain is whether a human can see it, which is the agent's to fix.

    const result = await runCcWithHost(
      [
        "spec",
        "request-approval",
        "native-sdd",
        "--gate",
        "requirements",
        "--json",
      ],
      baseEnv,
      makeHost({ deliveryUncertain: true }),
    );

    expect(inlineDataOf(result)).toMatchObject({
      deliveryOutcome: "delivery-uncertain",
    });
  });

  it("names the workflow execution an abandon retired and the attempt exit", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "abandon",
        "native-sdd",
        "--execution",
        "workflow-execution-1",
        "--reason",
        "Superseded",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    // The flag is forwarded verbatim: the id an agent holds is the workflow
    // execution id, and the server resolves it through the binding.
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      executionId: "workflow-execution-1",
      reason: "Superseded",
    });

    // I-13: the working exit off an abandoned run is a fresh attempt.

    const structured = await runCcWithHost(
      [
        "spec",
        "abandon",
        "native-sdd",
        "--execution",
        "workflow-execution-1",
        "--reason",
        "Superseded",
        "--json",
      ],
      baseEnv,
      makeHost(),
    );
    expect(JSON.parse(structured.stdout).recovery.references).toContainEqual({
      kind: "workflow-execution",
      id: "workflow-execution-1",
    });
  });

  it("posts a rename action with the new slug and optional name", async () => {
    const host = makeHost();
    const result = await runCcWithHost(
      [
        "spec",
        "rename",
        "native-sdd",
        "--to",
        "native-sdd-v2",
        "--name",
        "Native SDD v2",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const request = actionRequests(host)[0];
    expect(request?.url).toContain("/api/specs/demo/native-sdd/actions/rename");
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      slug: "native-sdd-v2",
      name: "Native SDD v2",
    });
  });

  it("16.9 records a discovery and states the two post-launch paths", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
    });
    const result = await runCcWithHost(
      ["spec", "capture", "native-sdd", "--file", TASK_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const request = actionRequests(host)[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/capture-scope-amendment",
    );
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    // No executionId and no blockingReason key at all — the live attempt names
    // the run, and blockingReason's mere presence abandons it.
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      discoveredTask: JSON.parse(DISCOVERED_TASK_FILE_CONTENT),
    });

    // The two post-launch paths are presented side by side.
  });

  it("16.9 passes --blocking-reason through and reports both ids", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
    });
    const result = await runCcWithHost(
      [
        "spec",
        "capture",
        "native-sdd",
        "--file",
        TASK_FILE,
        "--blocking-reason",
        "Discovered work blocks the run",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      discoveredTask: JSON.parse(DISCOVERED_TASK_FILE_CONTENT),
      blockingReason: "Discovered work blocks the run",
    });

    // The instruction used to name `replacement.abandonedExecutionId`, the
    // internal spec execution row id, which no verb accepts. Boundary-matched
    // because `execution-1` is also the tail of the workflow execution id this
    // receipt is required to print.
  });

  it("forwards an explicit --execution as the workflow execution id", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
    });
    const result = await runCcWithHost(
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "workflow-execution-1",
        "--file",
        TASK_FILE,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      executionId: "workflow-execution-1",
      discoveredTask: JSON.parse(DISCOVERED_TASK_FILE_CONTENT),
    });
  });

  it("names the workflow execution id in every capture receipt token", async () => {
    const nonBlocking = await runCcWithHost(
      ["spec", "capture", "native-sdd", "--file", TASK_FILE, "--json"],
      baseEnv,
      makeHost({ files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT } }),
    );
    expect(JSON.parse(nonBlocking.stdout).recovery.references).toContainEqual({
      kind: "workflow-execution",
      id: "workflow-execution-1",
    });

    const blocking = await runCcWithHost(
      [
        "spec",
        "capture",
        "native-sdd",
        "--file",
        TASK_FILE,
        "--blocking-reason",
        "Discovered work blocks the run",
        "--json",
      ],
      baseEnv,
      makeHost({ files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT } }),
    );
    expect(JSON.parse(blocking.stdout).recovery.references).toContainEqual({
      kind: "workflow-execution",
      id: "workflow-execution-1",
    });
  });

  it("rejects a discovered task that violates the capture schema before network", async () => {
    const host = makeHost({
      files: {
        [TASK_FILE]: JSON.stringify({ title: "Missing instructions" }),
      },
    });
    const result = await runCcWithHost(
      ["spec", "capture", "native-sdd", "--file", TASK_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl spec start against a delivery plan", () => {
  const CANDIDATE = {
    attemptId: "attempt-1",
    candidateId: "candidate-1",
    candidateHash: "sha256:candidate",
    workflowExecutionId: "workflow-execution-1",
    resolvedDefinitionHash: `sha256:${"d".repeat(64)}`,
  };

  it("rejects the retired scope file before reading it or contacting the server", async () => {
    const host = makeHost({
      approved: true,
      files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
    });

    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cctl spec plan open native-sdd");
    expect(result.stderr).not.toMatch(/legacy planning|--seed-from/i);
    expect(host.requests).toHaveLength(0);

    const structured = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE, "--json"],
      baseEnv,
      host,
    );
    expect(structured.exitCode).toBe(2);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: false,
      instruction: expect.stringContaining("cctl spec plan open native-sdd"),
      error: {},
    });
    expect(JSON.parse(structured.stdout).instruction).not.toMatch(
      /legacy planning|--seed-from/i,
    );
    expect(host.requests).toHaveLength(0);
  });

  it("forwards an inputs JSON object unchanged and reports every launch identity", async () => {
    const parameters = {
      required: "ticket-66",
      mode: "careful",
      brief: "Preserve this text exactly.\nIncluding its newline.",
    };
    const host = makeHost({
      approved: true,
      files: { [INPUTS_FILE]: JSON.stringify(parameters) },
      startBody: {
        body: {
          execution: {
            id: "execution-1",
            specId: spec.id,
            revisionId: "revision-approved",
            revisionNumber: 1,
            scope: null,
            state: "definition_review",
            workflowSeedSource: {
              kind: "spec_delivery",
              specSlug: "native-sdd",
              candidateId: "launch-1",
            },
            workflowExecutionId: null,
            sessionName: "feature-session",
            deliveredAt: null,
            abandonedReason: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
          workflowDefinition: {
            id: "candidate-1",
            revision: 4,
          },
          deliveryPlan: CANDIDATE,
        },
      },
    });

    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", INPUTS_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const started = host.requests.find((request) =>
      request.url.includes("/actions/start-execution"),
    );
    expect(JSON.parse(String(started?.init.body))).toEqual({
      revisionId: "revision-approved",
      sessionName: "feature-session",
      parameters,
    });
    expect(inlineDataOf(result)).toMatchObject({ deliveryPlan: CANDIDATE });
    expect(JSON.parse(result.stdout).recovery.references).toContainEqual({
      kind: "workflow-execution",
      id: "workflow-execution-1",
    });
    expect(JSON.parse(result.stdout).recovery.references).not.toContainEqual({
      kind: "workflow-execution",
      id: "execution-1",
    });
  });

  it("forwards an explicit empty parameter object", async () => {
    const host = makeHost({ approved: true });

    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", INPUTS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const started = host.requests.find((request) =>
      request.url.includes("/actions/start-execution"),
    );
    expect(JSON.parse(String(started?.init.body))).toEqual({
      revisionId: "revision-approved",
      sessionName: "feature-session",
      parameters: {},
    });
  });

  it("rejects a non-object execution parameter payload before requests", async () => {
    const host = makeHost({
      files: { [INPUTS_FILE]: '["not", "an", "object"]' },
    });
    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--file", INPUTS_FILE, "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("expected record"),
        }),
      ]),
    );
    expect(host.requests).toHaveLength(0);
  });

  it("reports a park as holding the candidate with no execution and no slot", async () => {
    const host = makeHost({
      approved: true,
      startBody: {
        body: {
          parked: {
            attemptId: CANDIDATE.attemptId,
            candidateId: CANDIDATE.candidateId,
            candidateHash: CANDIDATE.candidateHash,
            nextAct: {
              actor: "agent",
              command: "cctl spec start native-sdd --file .cc/temp/inputs.json",
              reason: "The approved parked candidate is ready to launch.",
            },
          },
        },
      },
    });

    const result = await runCcWithHost(
      ["spec", "start", "native-sdd", "--park", "--file", INPUTS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const started = host.requests.find((request) =>
      request.url.includes("/actions/start-execution"),
    );
    expect(JSON.parse(String(started?.init.body))).toMatchObject({
      park: true,
    });
  });
});

describe("cctl spec plan abandon", () => {
  function abandonHost(respond: () => Response): CliHost & {
    requests: RecordedRequest[];
  } {
    const requests: RecordedRequest[] = [];
    return {
      requests,
      async fetch(url, init) {
        requests.push({ url, init });
        return respond();
      },
      readTextFile: async () => null,
      readFileBytes: async () => null,
      sleep: async () => {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  }

  it("retires the prelaunch attempt through the plan-abandon action", async () => {
    const host = abandonHost(
      () =>
        new Response(JSON.stringify({ attemptId: "attempt-9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await runCcWithHost(
      [
        "spec",
        "plan",
        "abandon",
        "native-sdd",
        "--reason",
        "the spec amended past this attempt's pin",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const posted = host.requests[0];
    expect(new URL(posted?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/plan-abandon",
    );
    expect(JSON.parse(String(posted?.init.body))).toEqual({
      reason: "the spec amended past this attempt's pin",
    });
    expect(inlineDataOf(result)).toMatchObject({ attemptId: "attempt-9" });
  });
});

describe("plan write receipts name expectedDraftRevision (#80 I-7)", () => {
  function planView(
    status: "draft" | "proposed",
    draftRevision: number,
  ): unknown {
    return {
      attempt: {
        id: "attempt-1",
        specSlug: "native-sdd",
        status,
        draftRevision,
        pinnedRevisionId: "revision-approved",
        deltaBasisExecutionId: null,
        proposedSnapshotId: status === "proposed" ? "snapshot-1" : null,
        candidateId: status === "proposed" ? "candidate-1" : null,
        candidateHash: status === "proposed" ? "sha256:candidate" : null,
        launchedExecutionId: null,
        workflowDefinitionId: "wf-1",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
      approval: null,
      prelaunch: null,
      claims: [],
      reviewStatus: { state: "unreviewed" },
      document: { schemaVersion: 4, binding: { dispositions: [] } },
      workflowDefinition: {
        id: "wf-1",
        revision: 2,
        definitionHash: `sha256:${"d".repeat(64)}`,
        builderHref: "/workflows/wf-1",
      },
      health: { total: 0, blocking: 0, counts: [], findings: [] },
      ledger: {
        selected: 3,
        claimed: 2,
        unclaimed: 1,
        dispositions: [
          { kind: "in_scope", count: 3 },
          { kind: "deferred", count: 1 },
        ],
        charter: { state: "authored", invariantCount: 4, sourceCount: 6 },
      },
      dispositionCounts: [],
      unresolved: [
        {
          criterionElementId: "criterion-1",
          handle: "R1.1",
          disposition: "in_scope",
          resolution: "Claim it from a stable authored accountability context.",
        },
      ],
      snapshots: [],
      nextAct: {
        actor: "agent",
        command: "cctl spec plan propose native-sdd",
        reason: "The draft carries no blocking findings.",
      },
      previousHealth: null,
      invalidatedApproval: null,
      executionStartAdmission: null,
    };
  }

  function planHost(
    view: unknown,
    files: Record<string, string> = {},
  ): CliHost & { requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    return {
      requests,
      async fetch(url, init) {
        requests.push({ url, init });
        return new Response(JSON.stringify(view), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      readTextFile: async (filePath) => files[filePath] ?? null,
      readFileBytes: async () => null,
      sleep: async () => {},
      platform: "darwin",
      homedir: "/Users/test",
    };
  }

  it("names the token on the plan open receipt, in text and JSON", async () => {
    const host = planHost(planView("draft", 1));
    const text = await runCcWithHost(
      ["spec", "plan", "open", "native-sdd"],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "plan", "open", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);

    expect(inlineDataOf(structured)).toMatchObject({
      attempt: { draftRevision: 1 },
    });
  });

  it("names the token on the plan reopen receipt, in text and JSON", async () => {
    const host = planHost(planView("draft", 5));
    const text = await runCcWithHost(
      ["spec", "plan", "reopen", "native-sdd", "--reason", "retune"],
      baseEnv,
      host,
    );
    const structured = await runCcWithHost(
      ["spec", "plan", "reopen", "native-sdd", "--reason", "retune", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);

    expect(inlineDataOf(structured)).toMatchObject({
      attempt: { draftRevision: 5 },
    });
  });
});
