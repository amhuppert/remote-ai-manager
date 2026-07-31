import { describe, expect, it } from "vitest";

import {
  COMBINED_APPROVAL_DIAL,
  dialRequiresHumanApproval,
  resolveDial,
  type ResolvedGateDial,
} from "@/lib/specs/policy";
import {
  resolvedGateDialSchema,
  type SpecGatePreset,
} from "@/lib/specs/schemas";
import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";
import { executionStartActor } from "./write";

const CREATED_AT = "2026-07-18T00:00:00.000Z";
const SPEC_FILE = "/tmp/spec-element.json";
const BATCH_FILE = "/tmp/spec-elements.json";
const SCOPE_FILE = "/tmp/spec-scope.json";
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
    currentRevision: { revision: current, elements: [] },
    status: {
      ...statusBody(),
      phase: { primary: state },
    },
  };
}

// The write path's own read: everything a write must name and nothing else.
function editContextBody(
  state: "draft" | "approved" = "draft",
  preset = "contract-bearing",
) {
  const current = revision(state);
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
    element: null,
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
      | "claim-task-complete"
      | "draft-upsert"
      | "draft-batch"
      | "rename"
      | "capture-scope-amendment"
      | "abandon-spec"
      | "answer-question";
    approved?: boolean;
    /** false emulates a server built before handles were projected. */
    handles?: boolean;
    /** Drives the execution_start dial the CLI resolves locally. */
    preset?: SpecGatePreset;
    /** The approval ask was already open, so no second request was created. */
    alreadyRequested?: boolean;
  } = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const handle = (value: string): { handle?: string } =>
    options.handles === false ? {} : { handle: value };
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (init.method === "GET") {
        if (pathname.endsWith("/status")) return response(statusBody());
        if (pathname.endsWith("/edit-context"))
          return response(
            editContextBody(
              options.approved ? "approved" : "draft",
              options.preset,
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
      if (
        options.refusal === "claim-task-complete" &&
        action === "claim-task-complete"
      ) {
        return response(
          {
            code: "lint_blocked",
            unmetConditions: ["A task completion claim must cite evidence."],
            findings: [],
            instruction:
              "Cite ingested evidence ids for the task's covered criteria — the server ingests commit and validation evidence from workflow events — and claim again.",
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
      if (
        options.refusal === "capture-scope-amendment" &&
        action === "capture-scope-amendment"
      ) {
        return response(
          {
            code: "gate_blocked",
            unmetConditions: [
              "Discovered execution work can be captured only while the execution is running.",
            ],
            instruction:
              "Start the linked workflow or create a normal amendment outside execution.",
          },
          409,
        );
      }
      if (options.refusal === "draft-batch" && action === "draft-batch") {
        // Every refusing element is reported, not only the first, and the
        // batch as a whole wrote nothing.
        const refusals = [
          {
            index: 0,
            elementId: "requirement-id-1",
            code: "stale_element",
            unmetConditions: [
              "Element requirement-id-1 changed after it was read.",
            ],
            instruction: "Reconcile the current content and retry.",
            currentElementVersion: 4,
          },
          {
            index: 1,
            elementId: "criterion-id-1",
            code: "stage_blocked",
            unmetConditions: [
              "The requirements stage does not admit a criterion yet.",
            ],
            instruction: "Advance the draft, then resubmit.",
            currentElementVersion: null,
          },
        ];
        return response(
          {
            code: "stale_element",
            unmetConditions: refusals.map(
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
          return response({
            revision: {
              ...revision(),
              state: "proposed",
              proposedAt: CREATED_AT,
            },
            diff: {},
            absorbedSignOff: false,
          });
        case "advance":
          return response({
            revision: {
              ...revision(),
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
            status: "answered",
            answer: "The full scope.",
            answeredAt: CREATED_AT,
            provenance: null,
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
            disposition: "proposed",
            disposedAt: null,
            proposedBy: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          });
        case "open-question":
          return response({
            ...handle("Q2"),
            id: "question-id-2",
            number: 2,
            elementId: "task-id-1",
            text: "Which retention period applies?",
            status: "open",
            answer: null,
            answeredAt: null,
            provenance: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          });
        case "claim-task-complete":
          return response({
            id: "claim-id-1",
            spec_id: spec.id,
            revision_id: "revision-approved",
            task_element_id: "task-id-1",
            execution_id: "execution-1",
            actor_json: "{}",
            evidence_ids_json: '["evidence-1"]',
            claimed_at: CREATED_AT,
            status: "accepted",
          });
        case "request-approval":
          return response({
            attentionId: "attention-1",
            revisionId: "revision-draft",
            gate: "requirements",
            subject: "R1",
            alreadyRequested: options.alreadyRequested === true,
            elementId: "requirement-id-1",
          });
        case "start-execution":
          return response({
            execution: {
              id: "execution-1",
              specId: spec.id,
              revisionId: "revision-approved",
              revisionNumber: 1,
              scope: null,
              state: "definition_review",
              workflowDefinitionId: "workflow-1",
              workflowDefinitionRevision: 1,
              workflowExecutionId: null,
              definitionApprovalRequired:
                resolveDial(
                  { preset: options.preset ?? "contract-bearing" },
                  "execution_start",
                ) === "gate",
              sessionName: "feature-session",
              deliveredAt: null,
              abandonedReason: null,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
            definition: { id: "workflow-1" },
          });
        case "open-amendment":
          return response({
            ...revision(),
            id: "revision-amendment",
            number: 2,
            authoringStage: "plan",
            basedOnRevisionId: "revision-approved",
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
            workflow_execution_id: null,
            session_name: "feature-session",
            delivered_at: null,
            abandoned_reason: "Superseded",
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          });
        case "capture-scope-amendment": {
          const body: unknown = JSON.parse(init.body ?? "{}");
          const restartRequired =
            typeof body === "object" &&
            body !== null &&
            "blockingReason" in body;
          return response({
            revision: {
              ...revision(),
              id: "revision-amendment",
              number: 2,
              basedOnRevisionId: "revision-approved",
            },
            task: {
              element: {
                id: "task-id-2",
                specId: spec.id,
                kind: "task",
                number: 2,
                parentElementId: null,
                createdAt: CREATED_AT,
              },
              version: {
                revisionId: "revision-amendment",
                elementId: "task-id-2",
                position: 3,
                payload: {
                  kind: "task",
                  title: "Handle the discovered migration",
                  instructions: "Write the follow-up migration.",
                  tracedRequirementElementIds: [],
                  tracedDecisionElementIds: [],
                  coveredCriterionElementIds: [],
                  dependsOnTaskElementIds: [],
                },
                payloadHash: "task-2-hash",
                elementVersion: 1,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
              },
            },
            restartRequired,
          });
        }
        default:
          return response({ ok: true });
      }
    },
    async readTextFile(filePath) {
      return options.files?.[filePath] ?? null;
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

const FIRST_ELEMENT_FILE_CONTENT = JSON.stringify({
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
});

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

const DISCOVERED_TASK_FILE_CONTENT = JSON.stringify({
  title: "Handle the discovered migration",
  instructions: "Write the follow-up migration.",
  tracedRequirementElementIds: ["requirement-id-1"],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: ["criterion-id-1"],
  dependsOnTaskElementIds: [],
});

describe("cctl spec write verbs", () => {
  it("sends typed create, answer, assume, approval-request, and abandon mutations", async () => {
    const host = makeHost({
      files: { [SPEC_FILE]: FIRST_ELEMENT_FILE_CONTENT },
    });
    const commands = [
      [
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
      ],
      ["spec", "answer", "native-sdd/Q1", "--answer", "The full scope."],
      [
        "spec",
        "assume",
        "native-sdd",
        "--text",
        "SQLite remains authoritative.",
      ],
      [
        "spec",
        "request-approval",
        "native-sdd",
        "--gate",
        "requirements",
        "--subject",
        "R1",
      ],
      ["spec", "abandon", "native-sdd", "--reason", "Superseded"],
    ];
    for (const command of commands) {
      const result = await runCli(command, baseEnv, host);
      expect(result.exitCode).toBe(0);
    }

    const actions = actionRequests(host).map((request) => ({
      action: new URL(request.url).pathname.split("/").at(-1),
      body: JSON.parse(request.init.body ?? "{}"),
      conversation: request.init.headers["x-cc-conversation-id"],
    }));
    expect(actions.map((item) => item.action)).toEqual([
      "create",
      "answer-question",
      "propose-assumption",
      "request-approval",
      "abandon-spec",
    ]);
    expect(
      actions.every((item) => item.conversation === "conversation-1"),
    ).toBe(true);
    // The first draft save travels inside the single create request.
    expect(actions[0]?.body).toEqual({
      slug: "native-sdd",
      name: "Native SDD",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: JSON.parse(FIRST_ELEMENT_FILE_CONTENT),
    });
  });

  it("prints the addressing handle assigned by create, draft, and question", async () => {
    const host = makeHost({
      files: { [SPEC_FILE]: FIRST_ELEMENT_FILE_CONTENT },
    });

    const created = await runCli(
      [
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
      ],
      baseEnv,
      host,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("native-sdd/R1");

    const drafted = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        SPEC_FILE,
        "--base-version",
        "1",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(drafted.exitCode).toBe(0);
    expect(JSON.parse(drafted.stdout).draft.handle).toBe("T1");

    const questioned = await runCli(
      ["spec", "question", "native-sdd", "--text", "Which retention?"],
      baseEnv,
      host,
    );
    expect(questioned.exitCode).toBe(0);
    expect(questioned.stdout).toContain("native-sdd/Q2");
  });

  it("falls back to kind and version when an older server sends no handle", async () => {
    const host = makeHost({
      handles: false,
      files: { [SPEC_FILE]: FIRST_ELEMENT_FILE_CONTENT },
    });
    const drafted = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        SPEC_FILE,
        "--base-version",
        "1",
      ],
      baseEnv,
      host,
    );

    expect(drafted.exitCode).toBe(0);
    expect(drafted.stdout).toContain("saved task at version 1");
  });

  it("opens an amendment draft on an approved spec through its own verb", async () => {
    const host = makeHost({ approved: true });
    const result = await runCli(
      ["spec", "amend", "native-sdd", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = actionRequests(host)[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/open-amendment",
    );
    // The action body is strict: any extra key is a 400.
    expect(JSON.parse(request?.init.body ?? "null")).toEqual({});
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      revision: { id: "revision-amendment", number: 2, authoringStage: "plan" },
    });
  });

  it("names the amendment revision and its authoring stage in text mode", async () => {
    const result = await runCli(
      ["spec", "amend", "native-sdd"],
      baseEnv,
      makeHost({ approved: true }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("revision 2");
    expect(result.stdout).toContain("plan");
  });

  it("validates the amend slug locally before any network request", async () => {
    const host = makeHost();
    for (const argv of [
      ["spec", "amend"],
      ["spec", "amend", "Not A Slug!"],
      ["spec", "amend", "native-sdd", "extra"],
    ]) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("opens a question with a resolved element attachment", async () => {
    const host = makeHost();
    const result = await runCli(
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

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      question: { number: 2, status: "open" },
    });
    const post = actionRequests(host)[0];
    expect(new URL(post?.url ?? "").pathname.endsWith("/open-question")).toBe(
      true,
    );
    expect(JSON.parse(post?.init.body ?? "{}")).toEqual({
      elementId: "task-id-1",
      text: "Which retention period applies?",
    });
  });

  it("opens a spec-level question without an attachment", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "question", "native-sdd", "--text", "Is the scope right?"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      elementId: null,
      text: "Is the scope right?",
    });
  });

  it("requires --text for spec question before any network request", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "question", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--text");
    expect(host.requests).toHaveLength(0);
  });

  it("states the handle grammar for a malformed --element attachment", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "question", "native-sdd", "--text", "x", "--element", "task_7"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--element");
    expect(result.stderr).toContain("looks like an element id");
    expect(result.stderr).toContain("T<n> for a task");
    expect(host.requests).toHaveLength(0);
  });

  it("names the missing spec slug for a well-formed but unqualified handle", async () => {
    const host = makeHost();
    const task = await runCli(
      ["spec", "task", "complete", "T7", "--execution", "execution-1"],
      baseEnv,
      host,
    );
    const answer = await runCli(
      ["spec", "answer", "Q1", "--answer", "The full scope."],
      baseEnv,
      host,
    );

    expect(task.exitCode).toBe(2);
    expect(task.stderr).toContain(
      '"T7" is missing its spec slug; this command takes a qualified handle like <slug>/T7',
    );
    // T7 is a valid task handle, so the grammar refusal would be false, and
    // these commands cannot honor "optionally qualify".
    expect(task.stderr).not.toContain("not a valid element handle");
    expect(task.stderr).not.toContain("Optionally qualify");

    expect(answer.exitCode).toBe(2);
    expect(answer.stderr).toContain(
      '"Q1" is missing its spec slug; this command takes a qualified handle like <slug>/Q2',
    );
    expect(answer.stderr).not.toContain("not a valid element handle");
    expect(host.requests).toHaveLength(0);
  });

  it("turns the answer human_act_required refusal into the Studio handoff", async () => {
    const result = await runCli(
      ["spec", "answer", "native-sdd/Q1", "--answer", "Round to one decimal."],
      baseEnv,
      makeHost({ refusal: "answer-question" }),
    );

    expect(result.exitCode).toBe(1);
    // The agent's supported path is to hand the question to the operator, so
    // the refusal must name the exact surface and question.
    expect(result.stderr).toContain("Spec Studio");
    expect(result.stderr).toContain("Q1");
  });

  it("names the wrong element kind for a qualified handle these commands cannot take", async () => {
    const host = makeHost();
    const task = await runCli(
      [
        "spec",
        "task",
        "complete",
        "native-sdd/Q2",
        "--execution",
        "execution-1",
      ],
      baseEnv,
      host,
    );
    const answer = await runCli(
      ["spec", "answer", "native-sdd/T7", "--answer", "The full scope."],
      baseEnv,
      host,
    );

    const unqualified = await runCli(
      ["spec", "task", "complete", "Q2", "--execution", "execution-1"],
      baseEnv,
      host,
    );

    expect(task.exitCode).toBe(2);
    expect(task.stderr).toContain(
      '"native-sdd/Q2" is a question handle; this command takes a task handle like <slug>/T7',
    );
    // The wrong kind is the more useful diagnosis than the missing slug.
    expect(unqualified.exitCode).toBe(2);
    expect(unqualified.stderr).toContain(
      '"Q2" is a question handle; this command takes a task handle like <slug>/T7',
    );
    expect(answer.exitCode).toBe(2);
    expect(answer.stderr).toContain(
      '"native-sdd/T7" is a task handle; this command takes a question handle like <slug>/Q2',
    );
    expect(host.requests).toHaveLength(0);
  });

  it("keeps the grammar refusal for an ungrammatical task target and names the qualified form", async () => {
    const host = makeHost();
    const result = await runCli(
      [
        "spec",
        "task",
        "complete",
        "native-sdd/task_7",
        "--execution",
        "execution-1",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("looks like an element id");
    expect(result.stderr).toContain("T<n> for a task");
    expect(result.stderr).toContain(
      "This command takes the qualified form <slug>/T7",
    );
    expect(host.requests).toHaveLength(0);
  });

  it("rejects Q and A handles as question/assumption attachment targets before network", async () => {
    const host = makeHost();
    for (const argv of [
      ["spec", "question", "native-sdd", "--text", "x", "--element", "Q1"],
      ["spec", "question", "native-sdd", "--text", "x", "--element", "A1"],
      ["spec", "assume", "native-sdd", "--text", "x", "--element", "Q1"],
      ["spec", "assume", "native-sdd", "--text", "x", "--element", "A1"],
    ]) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--element");
    }
    expect(host.requests).toHaveLength(0);
  });

  it("refuses spec create without --file before any network request", async () => {
    const host = makeHost();
    const result = await runCli(
      [
        "spec",
        "create",
        "--slug",
        "native-sdd",
        "--name",
        "Native SDD",
        "--preset",
        "contract-bearing",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--file");
    expect(host.requests).toHaveLength(0);
  });

  it("sends base-versioned draft writes and surfaces current content on conflict", async () => {
    const elementFile = JSON.stringify({
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
    });
    const host = makeHost({
      files: { [SPEC_FILE]: elementFile },
      refusal: "draft-upsert",
    });
    const result = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        SPEC_FILE,
        "--base-version",
        "1",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "stale_element",
      details: {
        currentContent: { statement: "Winning content" },
        currentVersion: 2,
      },
    });
    const request = actionRequests(host)[0];
    expect(JSON.parse(request?.init.body ?? "{}")).toMatchObject({
      revisionId: "revision-draft",
      baseElementVersion: 1,
      elementId: "requirement-id-1",
    });
  });

  it("submits an array --file as one batch and reports each element by its index", async () => {
    const host = makeHost({ files: { [BATCH_FILE]: BATCH_FILE_CONTENT } });
    const text = await runCli(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );
    const structured = await runCli(
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

    expect(text.stdout).toContain("saved 2 elements");
    expect(text.stdout).toContain(
      "[0] native-sdd/R1 (requirement) at version 4",
    );
    expect(text.stdout).toContain(
      "[1] native-sdd/R1.1 (criterion) at version 1",
    );
    expect(structured.exitCode).toBe(0);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: true,
      batch: {
        revisionId: "revision-draft",
        written: [
          { index: 0, elementId: "requirement-id-1", handle: "R1" },
          { index: 1, elementId: "criterion-id-1", handle: "R1.1" },
        ],
      },
      tokens: { revision: "revision-draft" },
    });
  });

  it("names every element that refused a batch, by index, in text and json", async () => {
    const host = makeHost({
      files: { [BATCH_FILE]: BATCH_FILE_CONTENT },
      refusal: "draft-batch",
    });
    const text = await runCli(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain(
      "[0] requirement-id-1: stale_element — Element requirement-id-1 changed after it was read. (element is at version 4)",
    );
    expect(text.stderr).toContain(
      "[1] criterion-id-1: stage_blocked — The requirements stage does not admit a criterion yet.",
    );
    expect(text.stderr).toContain("nothing was written");

    expect(structured.exitCode).toBe(1);
    expect(JSON.parse(structured.stdout)).toMatchObject({
      ok: false,
      code: "stale_element",
      details: {
        refusals: [
          {
            index: 0,
            elementId: "requirement-id-1",
            code: "stale_element",
            currentElementVersion: 4,
          },
          {
            index: 1,
            elementId: "criterion-id-1",
            code: "stage_blocked",
            currentElementVersion: null,
          },
        ],
      },
    });
  });

  it("refuses --base-version alongside a batch file before any network request", async () => {
    const host = makeHost({ files: { [BATCH_FILE]: BATCH_FILE_CONTENT } });
    const result = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        BATCH_FILE,
        "--base-version",
        "3",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("baseElementVersion");
    expect(host.requests).toHaveLength(0);
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
    const result = await runCli(
      ["spec", "draft", "native-sdd", "--file", BATCH_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not match the required schema");
    expect(host.requests).toHaveLength(0);
  });

  it("names the failing field when a draft file misses the schema", async () => {
    const host = makeHost({
      files: {
        [SPEC_FILE]: JSON.stringify({
          elementId: "criterion-id-1",
          kind: "criterion",
          parentElementId: "requirement-id-1",
          payload: {
            kind: "criterion",
            text: "Rendered output matches a screenshot.",
            validationStrategy: { kinds: ["screenshot"] },
          },
        }),
      },
    });
    const result = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        SPEC_FILE,
        "--base-version",
        "new",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    // The refusal must point at the failing field, not just say "schema".
    expect(result.stderr).toContain("payload.validationStrategy.kinds");
    expect(host.requests).toHaveLength(0);
  });

  it("resolves a draft write's target revision from the edit-context read alone", async () => {
    const host = makeHost({
      files: { [SPEC_FILE]: FIRST_ELEMENT_FILE_CONTENT },
    });
    const result = await runCli(
      [
        "spec",
        "draft",
        "native-sdd",
        "--file",
        SPEC_FILE,
        "--base-version",
        "new",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    // Pinned as exact paths: a regression to the full spec GET would transfer
    // the whole document once per saved element.
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/actions/draft-upsert",
    ]);
  });

  it("resolves an execution's pinned revision and dial from the edit-context read alone", async () => {
    const host = makeHost({
      approved: true,
      files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/specs/demo/native-sdd/edit-context",
      "/api/specs/demo/native-sdd/actions/start-execution",
    ]);
    expect(
      JSON.parse(actionRequests(host)[0]?.init.body ?? "{}").revisionId,
    ).toBe("revision-approved");
  });

  it("prints the server's lint finding list when propose is refused", async () => {
    const result = await runCli(
      ["spec", "propose", "native-sdd"],
      baseEnv,
      makeHost({ refusal: "propose" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("R1.1 has no covering task");
    expect(result.stderr).toContain("Resolve the blocking lint findings");
  });

  it("advances the exact current draft and expected authoring stage", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "advance", "native-sdd", "--from", "requirements", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
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

  it("validates the expected advance stage before making a request", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "advance", "native-sdd", "--from", "plan"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("requirements or design");
    expect(host.requests).toHaveLength(0);
  });

  it("lets the server refuse an evidence-less task completion with instruction", async () => {
    const host = makeHost({ refusal: "claim-task-complete" });
    const result = await runCli(
      [
        "spec",
        "task",
        "complete",
        "native-sdd/T1",
        "--execution",
        "execution-1",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must cite evidence");
    expect(result.stderr).toContain("Cite ingested evidence");
    expect(
      JSON.parse(actionRequests(host)[0]?.init.body ?? "{}").evidenceIds,
    ).toEqual([]);
  });

  it("starts from a locally validated schema-backed scope file", async () => {
    const scope = SPEC_SCOPE;
    const host = makeHost({
      approved: true,
      files: { [SCOPE_FILE]: JSON.stringify(scope) },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      revisionId: "revision-approved",
      scope,
      sessionName: "feature-session",
    });
  });

  it("reports that spec start launched no workflow lane and names the next command", async () => {
    const host = makeHost({
      approved: true,
      preset: "exploratory",
      files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("execution-1");
    expect(result.stdout).toContain("no workflow lane has launched");
    expect(result.stdout).toContain("workflow definition: workflow-1");
    expect(result.stdout).toContain("cctl workflow start workflow-1");
    expect(result.stdout).toContain("acts next: agent");
  });

  it("names the human as the next actor when execution_start is a Gate", async () => {
    const host = makeHost({
      approved: true,
      files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("acts next: human");
    expect(result.stdout).toContain("cctl workflow start workflow-1");
    expect(result.stdout).not.toContain("acts next: agent");
  });

  it("carries the launch facts into the --json envelope", async () => {
    const host = makeHost({
      approved: true,
      preset: "exploratory",
      files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      workflowDefinitionId: "workflow-1",
      workflowLaunched: false,
      executionState: "definition_review",
      actsNext: "agent",
      instruction: expect.stringContaining("cctl workflow start workflow-1"),
    });
  });

  it("rejects an invalid scope file with exit 2 before network", async () => {
    const host = makeHost({
      files: {
        [SCOPE_FILE]: JSON.stringify({
          selectedTaskIds: ["task-id-1"],
          selectedCriterionIds: ["criterion-id-1"],
        }),
      },
    });
    const result = await runCli(
      ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("reports what create changed, the tokens it assigned, and the next command", async () => {
    const host = makeHost({
      files: { [SPEC_FILE]: FIRST_ELEMENT_FILE_CONTENT },
    });
    const text = await runCli(
      [
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
      ],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("created spec native-sdd");
    expect(text.stdout).toContain(
      "state: draft revision 1 at requirements stage",
    );
    expect(text.stdout).toContain("  handle: native-sdd/R1");
    expect(text.stdout).toContain("  revision: revision-draft");
    expect(text.stdout).toContain("  element version: 1");
    expect(text.stdout).toContain("acts next: agent");
    expect(text.stdout).toContain(
      "next: cctl spec draft native-sdd --file <element.json> --base-version new",
    );
  });

  it("reports the amendment draft's state and the command that authors into it", async () => {
    const result = await runCli(
      ["spec", "amend", "native-sdd"],
      baseEnv,
      makeHost({ approved: true }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state: draft revision 2 at plan stage");
    expect(result.stdout).toContain("  revision: revision-amendment");
    expect(result.stdout).toContain("acts next: agent");
    expect(result.stdout).toContain(
      "next: cctl spec draft native-sdd --file <element.json> --base-version new",
    );
  });

  it("names the human sign-off a propose is now blocked on", async () => {
    const result = await runCli(
      ["spec", "propose", "native-sdd"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state: revision 1 is proposed");
    expect(result.stdout).toContain("  revision: revision-draft");
    expect(result.stdout).toContain("acts next: human");
    expect(result.stdout).toContain(
      "next: cctl spec request-approval native-sdd --gate requirements",
    );
  });

  it("names the human answer an opened question waits on", async () => {
    const result = await runCli(
      ["spec", "question", "native-sdd", "--text", "Which retention period?"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state: question Q2 is open");
    expect(result.stdout).toContain("  handle: native-sdd/Q2");
    expect(result.stdout).toContain("acts next: human");
    expect(result.stdout).toContain("next: cctl spec status native-sdd");
  });

  it("names the human disposition a proposed assumption waits on", async () => {
    const result = await runCli(
      ["spec", "assume", "native-sdd", "--text", "SQLite stays authoritative."],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state: assumption A1 is proposed");
    expect(result.stdout).toContain("acts next: human");
  });

  it("reports the claim's status and the execution it was filed against", async () => {
    const result = await runCli(
      [
        "spec",
        "task",
        "complete",
        "native-sdd/T1",
        "--execution",
        "execution-1",
        "--evidence",
        "evidence-1",
      ],
      baseEnv,
      makeHost({ approved: true }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("state: claim accepted");
    expect(result.stdout).toContain("  execution: execution-1");
    expect(result.stdout).toContain("  claim: claim-id-1");
  });

  it("reports the attention record a requested approval created", async () => {
    const result = await runCli(
      ["spec", "request-approval", "native-sdd", "--gate", "requirements"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("  attention: attention-1");
    expect(result.stdout).toContain("acts next: human");
  });

  it("sends an omitted --subject as an omission for the server to resolve", async () => {
    const host = makeHost();
    await runCli(
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
    // A locally guessed gate-name subject would be refused invalid_subject;
    // the omission is what lets the server resolve the outstanding one.
    expect(body).toEqual({
      revisionId: "revision-draft",
      gate: "requirements",
    });
  });

  it("says an approval ask that was already open created no second request", async () => {
    const result = await runCli(
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

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    // A repeat must not read as a second Needs You entry, or an agent that
    // re-asks will believe it escalated when nothing changed.
    expect(envelope.changed).toContain("was already open");
    expect(envelope.changed).not.toContain("requested requirements approval");
    expect(envelope.request).toMatchObject({
      alreadyRequested: true,
      elementId: "requirement-id-1",
    });
    expect(envelope.tokens).toMatchObject({
      attention: "attention-1",
      revision: "revision-draft",
      elementId: "requirement-id-1",
    });
  });

  it("carries the mutation envelope into --json for every mutating verb", async () => {
    const result = await runCli(
      ["spec", "advance", "native-sdd", "--from", "requirements", "--json"],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      changed: expect.stringContaining("advanced revision 1"),
      state: "draft revision 1 at design stage",
      tokens: { revision: "revision-draft" },
      actsNext: "agent",
      next: expect.stringContaining("cctl spec draft native-sdd"),
    });
  });

  it("names the execution an abandon retired", async () => {
    const result = await runCli(
      [
        "spec",
        "abandon",
        "native-sdd",
        "--execution",
        "execution-1",
        "--reason",
        "Superseded",
      ],
      baseEnv,
      makeHost(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("abandoned execution execution-1");
    expect(result.stdout).toContain("acts next: agent");
  });

  it("offers the open-question path when whole-spec abandon is refused as human-only", async () => {
    const result = await runCli(
      ["spec", "abandon", "native-sdd", "--reason", "Superseded"],
      baseEnv,
      makeHost({ refusal: "abandon-spec" }),
    );

    expect(result.exitCode).toBe(1);
    // R25.7: the agent's supported path is to raise the proposal, not to retry.
    expect(result.stderr).toContain("cctl spec question native-sdd --text");
    expect(result.stderr).toContain("Spec Studio");
  });

  it("requires an abandon reason locally", async () => {
    const host = makeHost();
    const result = await runCli(
      ["spec", "abandon", "native-sdd"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason");
    expect(host.requests).toHaveLength(0);
  });

  it("posts a rename action with the new slug and optional name", async () => {
    const host = makeHost();
    const result = await runCli(
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

    expect(result.exitCode).toBe(0);
    const request = actionRequests(host)[0];
    expect(request?.url).toContain("/api/specs/demo/native-sdd/actions/rename");
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      slug: "native-sdd-v2",
      name: "Native SDD v2",
    });
    expect(result.stdout).toContain("native-sdd-v2");
  });

  it("requires --to and validates both slugs locally before network", async () => {
    const host = makeHost();

    const missingTo = await runCli(
      ["spec", "rename", "native-sdd"],
      baseEnv,
      host,
    );
    expect(missingTo.exitCode).toBe(2);
    expect(missingTo.stderr).toContain("--to");

    const invalidTarget = await runCli(
      ["spec", "rename", "native-sdd", "--to", "Not A Slug!"],
      baseEnv,
      host,
    );
    expect(invalidTarget.exitCode).toBe(2);

    const invalidSource = await runCli(
      ["spec", "rename", "Not A Slug!", "--to", "native-sdd-v2"],
      baseEnv,
      host,
    );
    expect(invalidSource.exitCode).toBe(2);

    expect(host.requests).toHaveLength(0);
  });

  it("surfaces the typed human_act_required refusal for an agent rename", async () => {
    const host = makeHost({ refusal: "rename" });
    const result = await runCli(
      ["spec", "rename", "native-sdd", "--to", "native-sdd-v2"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("human-only");
    expect(result.stderr).toContain(
      "Ask the operator to rename the spec from Spec Studio.",
    );
  });

  it("16.9 captures discovered work as a scope amendment without touching the run", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
    });
    const result = await runCli(
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "execution-1",
        "--file",
        TASK_FILE,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = actionRequests(host)[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/specs/demo/native-sdd/actions/capture-scope-amendment",
    );
    expect(request?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-1",
    );
    // No blockingReason key at all — its mere presence abandons the run.
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      executionId: "execution-1",
      discoveredTask: JSON.parse(DISCOVERED_TASK_FILE_CONTENT),
    });
    expect(result.stdout).toContain("T2");
    expect(result.stdout).toContain("revision 2");
    expect(result.stdout).not.toContain("abandoned");
  });

  it("16.9 passes --blocking-reason through and reports the abandoned run", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
    });
    const result = await runCli(
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "execution-1",
        "--file",
        TASK_FILE,
        "--blocking-reason",
        "Discovered work blocks the run",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(actionRequests(host)[0]?.init.body ?? "{}")).toEqual({
      executionId: "execution-1",
      discoveredTask: JSON.parse(DISCOVERED_TASK_FILE_CONTENT),
      blockingReason: "Discovered work blocks the run",
    });
    expect(result.stdout).toContain("abandoned");
  });

  it("rejects an invalid discovered-task file with exit 2 before network", async () => {
    const host = makeHost({
      files: {
        [TASK_FILE]: JSON.stringify({ title: "Missing instructions" }),
      },
    });
    const result = await runCli(
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "execution-1",
        "--file",
        TASK_FILE,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("requires --execution and --file for spec capture before any network request", async () => {
    const host = makeHost();
    for (const argv of [
      ["spec", "capture", "native-sdd", "--file", TASK_FILE],
      ["spec", "capture", "native-sdd", "--execution", "execution-1"],
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "execution-1",
        "--file",
        TASK_FILE,
        "--blocking-reason",
        "   ",
      ],
    ]) {
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
    }
    expect(host.requests).toHaveLength(0);
  });

  it("surfaces the typed refusal when capture targets a non-running execution", async () => {
    const host = makeHost({
      files: { [TASK_FILE]: DISCOVERED_TASK_FILE_CONTENT },
      refusal: "capture-scope-amendment",
    });
    const result = await runCli(
      [
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "execution-1",
        "--file",
        TASK_FILE,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only while the execution is running");
    expect(result.stderr).toContain(
      "Start the linked workflow or create a normal amendment outside execution.",
    );
  });

  it("does not expose policy, sign-off, or verdict verbs", async () => {
    const host = makeHost();
    for (const verb of ["policy", "sign-off", "verdict"]) {
      const result = await runCli(["spec", verb], baseEnv, host);
      expect(result.exitCode).toBe(2);
    }
    expect(host.requests).toHaveLength(0);
  });
});

describe("the actor cctl spec start hands the parked run to", () => {
  /**
   * Keyed by the dial type, so a dial added to the schema fails to compile
   * here instead of silently falling through to "agent" in the CLI.
   */
  const EXPECTED_ACTOR: Record<ResolvedGateDial, "agent" | "human"> = {
    gate: "human",
    [COMBINED_APPROVAL_DIAL]: "human",
    notify: "agent",
    off: "agent",
  };

  it("names the human for every dial the server treats as a human act", () => {
    for (const [key, expected] of Object.entries(EXPECTED_ACTOR)) {
      const dial = resolvedGateDialSchema.parse(key);
      expect(executionStartActor(dial)).toBe(expected);
      // The CLI's notion of "a human acts next" must be the server's, not a
      // second reading of the dial: disagreement here is a false handoff.
      expect(executionStartActor(dial)).toBe(
        dialRequiresHumanApproval(dial) ? "human" : "agent",
      );
    }
  });

  it.each<SpecGatePreset>(["contract-bearing", "exploratory", "fast-path"])(
    "prints the actor the canonical predicate names under the %s preset",
    async (preset) => {
      const host = makeHost({
        approved: true,
        preset,
        files: { [SCOPE_FILE]: JSON.stringify(SPEC_SCOPE) },
      });
      const result = await runCli(
        ["spec", "start", "native-sdd", "--file", SCOPE_FILE],
        baseEnv,
        host,
      );

      const dial = resolveDial({ preset }, "execution_start");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `acts next: ${dialRequiresHumanApproval(dial) ? "human" : "agent"}`,
      );
      // The prose names the dial that was resolved, so it cannot keep claiming
      // one dial while the handoff is decided by another.
      expect(result.stdout).toContain(`execution_start dial is ${dial}`);
    },
  );
});
