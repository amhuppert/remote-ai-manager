import { describe, expect, it } from "vitest";

import { runCli } from "../../core";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

const CREATED_AT = "2026-07-18T00:00:00.000Z";
const SPEC_FILE = "/tmp/spec-element.json";
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

function detailBody(state: "draft" | "approved" = "draft") {
  const current = revision(state);
  return {
    spec,
    aliases: [],
    revisions: [current],
    currentRevision: { revision: current, elements: [] },
    status: {
      ...statusBody(),
      phase: { primary: state },
    },
  };
}

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
      | "rename"
      | "capture-scope-amendment";
    approved?: boolean;
  } = {},
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (init.method === "GET") {
        if (pathname.endsWith("/status")) return response(statusBody());
        if (pathname.includes("/elements/T1"))
          return response(taskElementBody());
        return response(detailBody(options.approved ? "approved" : "draft"));
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
              "Attach resolvable evidence for the task's covered criteria and claim again.",
          },
          409,
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
            spec_id: spec.id,
            number: 1,
            element_id: null,
            text: "Which scope?",
            provenance_json: "{}",
            status: "answered",
            answer: "The full scope.",
            answered_at: CREATED_AT,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          });
        case "propose-assumption":
          return response({
            id: "assumption-id-1",
            spec_id: spec.id,
            number: 1,
            element_id: null,
            text: "SQLite remains authoritative.",
            proposed_by_json: "{}",
            disposition: "proposed",
            disposed_at: null,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          });
        case "open-question":
          return response({
            id: "question-id-2",
            spec_id: spec.id,
            number: 2,
            element_id: "task-id-1",
            text: "Which retention period applies?",
            provenance_json: "{}",
            status: "open",
            answer: null,
            answered_at: null,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
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
          });
        case "start-execution":
          return response({
            execution: {
              id: "execution-1",
              spec_id: spec.id,
              revision_id: "revision-approved",
              scope_json: "{}",
              state: "definition_review",
              workflow_definition_id: "workflow-1",
              workflow_execution_id: null,
              session_name: "feature-session",
              delivered_at: null,
              abandoned_reason: null,
              created_at: CREATED_AT,
              updated_at: CREATED_AT,
            },
            definition: { id: "workflow-1" },
          });
        case "abandon-spec":
          return response({
            ...spec,
            abandonedAt: CREATED_AT,
            abandonedReason: "Superseded",
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
    expect(result.stderr).toContain("Attach resolvable evidence");
    expect(
      JSON.parse(actionRequests(host)[0]?.init.body ?? "{}").evidenceIds,
    ).toEqual([]);
  });

  it("starts from a locally validated schema-backed scope file", async () => {
    const scope = {
      selectedTaskIds: ["task-id-1"],
      selectedCriterionIds: ["criterion-id-1"],
      exclusionDispositions: [
        { criterionId: "criterion-id-2", disposition: "deferred" },
      ],
    };
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
