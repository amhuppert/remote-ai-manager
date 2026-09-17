import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const timestamp = "2026-09-01T00:00:00.000Z";
const spec = {
  id: "spec-one",
  projectPath: "/repo",
  slug: "native-sdd",
  name: "Native SDD",
  gatePolicy: { preset: "contract-bearing" },
  abandonedAt: null,
  abandonedReason: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const revision = {
  id: "revision-one",
  specId: spec.id,
  number: 1,
  state: "draft",
  authoringStage: "requirements",
  basedOnRevisionId: null,
  contentHash: null,
  citationContractVersion: 2,
  citationVersion: 1,
  citationHash: "a".repeat(64),
  proposedAt: null,
  approvedAt: null,
  createdAt: timestamp,
};
const edit = {
  specId: spec.id,
  slug: spec.slug,
  name: spec.name,
  gatePolicy: spec.gatePolicy,
  currentRevision: {
    id: revision.id,
    number: 1,
    state: "draft",
    authoringStage: "requirements",
  },
  latestApprovedRevision: null,
  element: null,
};
const payload = {
  kind: "requirement",
  statement: "Preserve durable receipts",
  priority: "must",
  risk: "high",
};
const document = {
  elementId: "requirement-one",
  kind: "requirement",
  parentElementId: null,
  position: 0,
  baseElementVersion: null,
  payload,
};
const element = {
  id: "requirement-one",
  specId: spec.id,
  kind: "requirement",
  number: 1,
  parentElementId: null,
  createdAt: timestamp,
};
const version = {
  revisionId: revision.id,
  elementId: element.id,
  position: 0,
  payload,
  payloadHash: "hash",
  elementVersion: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const saved = { element, version, handle: "R1", revived: false };
const base = "/api/specs/project-one/native-sdd";
const bundle = {
  slug: "native-sdd",
  name: "Native SDD",
  source: { label: "Legacy" },
  sections: [],
  requirements: [],
  decisions: [],
  questions: [],
  assumptions: [],
};
const counts = {
  sections: 0,
  requirements: 0,
  criteria: 0,
  decisions: 0,
  questions: 0,
  assumptions: 0,
};
const preview = {
  dryRun: true,
  preview: {
    counts,
    handles: {
      requirements: [],
      criteria: [],
      decisions: [],
      questions: [],
      assumptions: [],
    },
    findings: [],
    blocking: 0,
  },
};

function body(value: { init: { body?: string } } | undefined): unknown {
  return JSON.parse(value?.init.body ?? "null");
}
function refused() {
  return jsonReply(
    {
      error: "Human approval required",
      code: "human_act_required",
      rationale: "The durable decision belongs to a human.",
      instruction: "Open Spec Studio to record this decision.",
    },
    403,
  );
}

describe("native spec writes", () => {
  it("writes the first element with caller provenance", async () => {
    const test = createCcRuntimeFixture({
      files: { "/element.json": JSON.stringify(document) },
      env: { CC_AGENT_BACKEND: "codex" },
      respond: () => jsonReply({ spec, draft: revision, ...saved }),
    });
    const result = await test.run([
      "spec",
      "create",
      "--slug",
      "native-sdd",
      "--name",
      "Native SDD",
      "--preset",
      "contract-bearing",
      "--file",
      "/element.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(body(test.requests[0])).toMatchObject({
      slug: "native-sdd",
      gatePolicy: { preset: "contract-bearing" },
      initialElement: document,
    });
    expect(test.requests[0]?.init.headers).toMatchObject({
      "x-cc-conversation-id": "conversation-one",
      "x-cc-agent-backend": "codex",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: {
        references: expect.arrayContaining([{ kind: "spec", id: spec.id }]),
      },
    });
  });

  it("rejects a first-element version before acquiring mutation context", async () => {
    const test = createCcRuntimeFixture({
      files: {
        "/element.json": JSON.stringify({ ...document, baseElementVersion: 4 }),
      },
      respond: () => jsonReply({}),
    });
    const result = await test.run([
      "spec",
      "create",
      "--slug",
      "native-sdd",
      "--name",
      "Native SDD",
      "--preset",
      "contract-bearing",
      "--file",
      "/element.json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("baseElementVersion");
    expect(test.requests).toEqual([]);
  });

  it("binds a draft write to edit-context and the file's element version", async () => {
    const test = createCcRuntimeFixture({
      files: {
        "/element.json": JSON.stringify({ ...document, baseElementVersion: 3 }),
      },
      respond: ({ url }) => {
        if (url.includes("edit-context")) return jsonReply(edit);
        if (url.endsWith("/lint")) return jsonReply({ malformed: true });
        return jsonReply(saved);
      },
    });
    const result = await test.run([
      "spec",
      "draft",
      "native-sdd",
      "--file",
      "/element.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const post = test.requests.find(
      (request) => request.init.method === "POST",
    );
    expect(post?.url).toBe(`http://cc.test${base}/actions/draft-upsert`);
    expect(body(post)).toMatchObject({
      revisionId: revision.id,
      baseElementVersion: 3,
      payload,
    });
  });

  it("submits a keyed draft batch and its removals in one mutation", async () => {
    const input = {
      elements: [document],
      removals: [{ elementId: "old-element", baseElementVersion: 7 }],
    };
    const test = createCcRuntimeFixture({
      files: { "/batch.json": JSON.stringify(input) },
      respond: ({ url }) =>
        url.includes("edit-context")
          ? jsonReply(edit)
          : url.endsWith("/lint")
            ? jsonReply({})
            : jsonReply({
                revisionId: revision.id,
                written: [{ ...saved, index: 0, elementId: element.id }],
              }),
    });
    const result = await test.run([
      "spec",
      "draft",
      "native-sdd",
      "--file",
      "/batch.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
    expect(
      body(test.requests.find((request) => request.init.method === "POST")),
    ).toMatchObject({ revisionId: revision.id, ...input });
  });

  it("refuses removal when the current revision changes between handle lookups", async () => {
    let index = 0;
    const test = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          ...edit,
          currentRevision: {
            ...edit.currentRevision,
            id: `revision-${++index}`,
          },
          element: {
            elementId: `element-${index}`,
            handle: `R${index}`,
            kind: "requirement",
            elementVersion: 1,
            position: 0,
          },
        }),
    });
    const result = await test.run(["spec", "remove", "native-sdd", "R1", "R2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("revision");
    expect(
      test.requests.every((request) => request.init.method === "GET"),
    ).toBe(true);
  });

  it("withdraws the explicitly named proposal without replacing its concurrency token", async () => {
    const test = createCcRuntimeFixture({ respond: () => refused() });
    const result = await test.run([
      "spec",
      "withdraw-proposal",
      "native-sdd",
      "--revision",
      "proposal-seen",
    ]);
    expect(body(test.requests[0])).toEqual({ revisionId: "proposal-seen" });
    expect(test.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Open Spec Studio to record this decision.",
    });
  });

  it.each([
    ["amend", [], "open-amendment", {}],
    [
      "dismiss-superseded",
      ["--revision", "old", "--reason", "superseded"],
      "dismiss-superseded",
      { revisionId: "old", reason: "superseded" },
    ],
    ["rename", ["--to", "renamed"], "rename", { slug: "renamed" }],
    [
      "abandon",
      ["--execution", "workflow-one", "--reason", "superseded"],
      "abandon-execution",
      { executionId: "workflow-one", reason: "superseded" },
    ],
  ] as const)(
    "preserves %s action input and authoritative refusal",
    async (verb, flags, action, expected) => {
      const test = createCcRuntimeFixture({ respond: () => refused() });
      const result = await test.run(["spec", verb, "native-sdd", ...flags]);
      expect(test.requests[0]?.url).toBe(
        `http://cc.test${base}/actions/${action}`,
      );
      expect(body(test.requests[0])).toEqual(expected);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "not_applied",
        error: { details: { serverCode: "human_act_required" } },
        instruction: "Open Spec Studio to record this decision.",
      });
    },
  );

  it("keeps uncertainty when a mutation response is malformed or disconnected", async () => {
    const test = createCcRuntimeFixture({
      respond: () => jsonReply({ malformed: true }),
    });
    const result = await test.run(["spec", "amend", "native-sdd"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "unknown",
      error: { code: "CC_INVALID_RESPONSE" },
      recovery: { references: [{ kind: "spec", id: "native-sdd" }] },
    });
    const disconnected = createCcRuntimeFixture({
      respond: () => {
        throw new Error("lost response");
      },
    });
    const lost = await disconnected.run(["spec", "amend", "native-sdd"]);
    expect(JSON.parse(lost.stdout)).toMatchObject({
      effect: "unknown",
      error: { code: "CC_CONNECTION" },
    });
  });

  it("preserves human-only answer refusal after resolving the question's version", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "GET"
          ? jsonReply({
              openQuestions: [
                { id: "question-one", handle: "Q2", recordVersion: 8 },
              ],
            })
          : refused(),
    });
    const result = await test.run([
      "spec",
      "answer",
      "native-sdd/Q2",
      "--answer",
      "Ninety days",
    ]);
    expect(body(test.requests[1])).toEqual({
      questionId: "question-one",
      recordVersion: 8,
      answer: "Ninety days",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: expect.stringContaining("Spec Studio"),
    });
  });

  it("uses the proposed candidate's exact id and hash for plan sign-off", async () => {
    const test = createCcRuntimeFixture({ respond: () => refused() });
    const result = await test.run([
      "spec",
      "plan",
      "sign-off",
      "native-sdd",
      "--candidate",
      "candidate-seen",
      "--candidate-hash",
      "hash-seen",
    ]);
    expect(test.requests).toHaveLength(1);
    expect(body(test.requests[0])).toEqual({
      candidateId: "candidate-seen",
      candidateHash: "hash-seen",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: expect.stringContaining("Spec Studio"),
    });
  });

  it("requires both explicit plan candidate fields before contacting the server", async () => {
    const test = createCcRuntimeFixture({ respond: () => refused() });
    const result = await test.run([
      "spec",
      "plan",
      "sign-off",
      "native-sdd",
      "--candidate",
      "candidate-seen",
    ]);
    expect(result.exitCode).toBe(2);
    expect(test.requests).toEqual([]);
  });

  it("previews imports without committing and refuses legacy dryRun:true on the write", async () => {
    const test = createCcRuntimeFixture({
      files: { "/bundle.json": JSON.stringify({ ...bundle, dryRun: true }) },
      respond: () => jsonReply(preview),
    });
    const result = await test.run([
      "spec",
      "import-preview",
      "--file",
      "/bundle.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: preview },
    });
    expect(body(test.requests[0])).toMatchObject({ dryRun: true });
    const refused = await test.run([
      "spec",
      "import",
      "--file",
      "/bundle.json",
    ]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("import-preview");
    expect(test.requests).toHaveLength(1);
  });

  it("rehearses import admission before performing a real import", async () => {
    const test = createCcRuntimeFixture({
      files: { "/bundle.json": JSON.stringify(bundle) },
      respond: (request) =>
        JSON.parse(request.init.body ?? "null").dryRun
          ? jsonReply(preview)
          : jsonReply({ spec, revision, counts }),
    });
    const result = await test.run(["spec", "import", "--file", "/bundle.json"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests.map((request) => body(request))).toMatchObject([
      { dryRun: true },
      { dryRun: false },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { spec, counts } },
    });
  });

  it("pins the approved revision and session when starting with parameters", async () => {
    const test = createCcRuntimeFixture({
      files: { "/inputs.json": JSON.stringify({ region: "local" }) },
      respond: (request) =>
        request.init.method === "GET"
          ? jsonReply({
              ...edit,
              latestApprovedRevision: { id: "approved-seen", number: 2 },
            })
          : refused(),
    });
    await test.run([
      "spec",
      "start",
      "native-sdd",
      "--file",
      "/inputs.json",
      "--park",
    ]);
    expect(
      body(test.requests.find((request) => request.init.method === "POST")),
    ).toEqual({
      revisionId: "approved-seen",
      sessionName: "session-one",
      parameters: { region: "local" },
      park: true,
    });
  });

  it("reports a parked candidate without claiming an execution was launched", async () => {
    const parked = {
      attemptId: "attempt-one",
      candidateId: "candidate-one",
      candidateHash: "hash-one",
      nextAct: {
        actor: "human",
        command: "Review in Spec Studio",
        reason: "Candidate review remains owed",
      },
    };
    const test = createCcRuntimeFixture({
      files: { "/inputs.json": "{}" },
      respond: (request) =>
        request.init.method === "GET" ? jsonReply(edit) : jsonReply({ parked }),
    });
    const result = await test.run([
      "spec",
      "start",
      "native-sdd",
      "--file",
      "/inputs.json",
      "--park",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      effect: "applied",
      payload: { data: { parked } },
    });
    expect(envelope.recovery.references).toEqual([
      { kind: "spec-delivery-attempt", id: "attempt-one" },
      { kind: "spec-delivery-candidate", id: "candidate-one" },
    ]);
  });

  it.each([false, true])(
    "preserves capture's queued versus replacement semantics: blocking=%s",
    async (blocking) => {
      const task = {
        title: "Discovered work",
        instructions: "Implement the discovered case",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      };
      const receipt = {
        discovery: {
          id: "discovery-one",
          executionId: "internal-execution",
          workflowExecutionId: "workflow-one",
          attemptId: "attempt-one",
          title: task.title,
        },
        restartRequired: blocking,
        replacement: blocking
          ? {
              abandonedExecutionId: "internal-execution",
              abandonedWorkflowExecutionId: "workflow-one",
              replacementAttemptId: "attempt-two",
            }
          : null,
      };
      const test = createCcRuntimeFixture({
        files: { "/task.json": JSON.stringify(task) },
        respond: () => jsonReply(receipt),
      });
      const result = await test.run([
        "spec",
        "capture",
        "native-sdd",
        "--execution",
        "workflow-one",
        "--file",
        "/task.json",
        ...(blocking ? ["--blocking-reason", "Cannot safely continue"] : []),
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(body(test.requests[0])).toEqual({
        executionId: "workflow-one",
        discoveredTask: task,
        ...(blocking ? { blockingReason: "Cannot safely continue" } : {}),
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: { data: receipt },
        instruction: expect.stringContaining(
          blocking
            ? "Stop work on retired execution workflow-one"
            : "run keeps its pinned scope",
        ),
      });
    },
  );

  it("keeps the explicit spec target when executing an amendment status hint", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ revision, skippedWithdrawnRevisions: [] }),
    });
    const result = await fixture.run([
      "spec",
      "amend",
      "native-sdd",
      "--project",
      "other-project",
      "--server",
      "https://other.test",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const followup: string = JSON.parse(result.stdout).hint;
    const replay = createCcRuntimeFixture({
      respond: () =>
        jsonReply({ error: "Target reached", code: "gate_blocked" }, 409),
    });
    await replay.run(followup.slice(followup.indexOf("cctl ") + 5).split(" "));
    expect(replay.requests.map((request) => request.url)).toEqual([
      "https://other.test/api/specs/other-project/native-sdd/status",
    ]);
  });

  it("keeps a saved approval request distinct from uncertain notification delivery", async () => {
    const receipt = {
      revisionId: revision.id,
      gate: "requirements",
      subject: "requirements",
      scope: "gate",
      attentionId: "attention-one",
      alreadyRequested: true,
      elementId: null,
      outstandingSubjects: ["R1"],
      signOffOutstanding: true,
      deliveryOutcome: "delivery-uncertain",
    };
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "GET" ? jsonReply(edit) : jsonReply(receipt),
    });
    const result = await test.run([
      "spec",
      "request-approval",
      "native-sdd",
      "--gate",
      "requirements",
      "--project",
      "other-project",
      "--server",
      "https://other.test",
      "--conversation",
      "other-conversation",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const followup: string = JSON.parse(result.stdout).hint;
    const replay = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "GET" ? jsonReply(edit) : jsonReply(receipt),
    });
    const retried = await replay.run(
      followup.slice(followup.indexOf("cctl ") + 5).split(" "),
    );
    expect(retried.exitCode, retried.stdout).toBe(0);
    expect(replay.requests.map((request) => request.url)).toEqual([
      "https://other.test/api/specs/other-project/native-sdd/edit-context",
      "https://other.test/api/specs/other-project/native-sdd/actions/request-approval",
    ]);
    expect(replay.requests[1]?.init.headers?.["x-cc-conversation-id"]).toBe(
      "other-conversation",
    );
    expect(body(replay.requests[1])).toMatchObject({
      gate: "requirements",
      revisionId: revision.id,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: receipt },
      hint: expect.stringContaining("without duplicating the request"),
      recovery: {
        references: [{ kind: "approval-request", id: "attention-one" }],
      },
    });
  });

  it("preserves import admission's server refusal instruction without committing", async () => {
    const test = createCcRuntimeFixture({
      files: { "/bundle.json": JSON.stringify(bundle) },
      respond: () => refused(),
    });
    const result = await test.run(["spec", "import", "--file", "/bundle.json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "CC_OPERATION_FAILED" },
      instruction: "Open Spec Studio to record this decision.",
    });
    expect(test.requests).toHaveLength(1);
    expect(body(test.requests[0])).toMatchObject({ dryRun: true });
  });

  it("renders the server's actual pending gate and filed approval requests after propose", async () => {
    const proposal = {
      revision: { ...revision, authoringStage: "design", state: "proposed" },
      diff: { classifications: [], changeList: [], planStale: false },
      absorbedSignOff: false,
      pendingBlock: {
        actsNext: "human",
        gates: [],
        outstandingSubjects: [
          { gate: "requirements", subject: "R1", elementId: element.id },
        ],
        signOff: null,
        unmetConditions: ["requirements approval remains owed"],
        display: "requirements gate needs R1 approval",
        instruction: "Ask the human to approve R1 in Spec Studio.",
      },
      nextAction: null,
      approvalLedger: {
        subjects: [],
        satisfied: 0,
        carried: 0,
        currentRevision: 0,
        importSettled: 0,
        combinedAct: 0,
        pending: 1,
        governedBy: "per_subject",
        carryRule: "unchanged subject content",
      },
      approvalRequests: [
        {
          gate: "requirements",
          outcome: "filed",
          attentionId: "attention-requirements",
        },
        {
          gate: "design",
          outcome: "already-filed",
          attentionId: "attention-design",
        },
      ],
    };
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "GET" ? jsonReply(edit) : jsonReply(proposal),
    });
    const result = await test.run(["spec", "propose", "native-sdd"], "text");
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "acts next: human — requirements gate needs R1 approval",
    );
    expect(result.stdout).toContain(
      "requirements filed (attention attention-requirements)",
    );
    expect(result.stdout).toContain(
      "design already filed (attention attention-design)",
    );
    expect(result.stdout).toContain(
      "instruction: Ask the human to approve R1 in Spec Studio.",
    );
    expect(result.stdout).not.toContain("the design gate needs human sign-off");
  });
});
