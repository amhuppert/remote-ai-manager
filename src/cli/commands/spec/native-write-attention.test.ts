import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const timestamp = "2026-09-01T00:00:00.000Z";
const question = {
  id: "question-one",
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
  createdAt: timestamp,
  updatedAt: timestamp,
};
const assumption = {
  id: "assumption-one",
  number: 1,
  handle: "A1",
  elementId: null,
  text: "SQLite remains authoritative.",
  recordVersion: 4,
  disposition: "proposed",
  disposedAt: null,
  withdrawnAt: null,
  proposedBy: null,
  supersedesHandle: null,
  supersededByHandle: null,
  currentDraftCitations: {
    revisionId: "draft-seen",
    citationVersion: 2,
    citationHash: "a".repeat(64),
    citations: [],
  },
  presentation: {
    state: "current",
    attentionActive: true,
    lastMutation: null,
    humanCapability: { kind: "dispose", allowed: true },
  },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const receipt = {
  operation: "edited",
  recordKind: "question",
  recordId: question.id,
  recordHandle: "Q1",
  previousRecordVersion: 3,
  newRecordVersion: 4,
  lifecycle: "open",
  draftRevisionId: null,
  previousCitationVersion: null,
  newCitationVersion: null,
  citationChanges: { added: [], removed: [], refreshed: [] },
  idempotentReplay: false,
};
const target = (
  record:
    | (Omit<typeof assumption, "supersededByHandle"> & {
        supersededByHandle: string | null;
      })
    | typeof question,
) => ({
  specId: "spec-one",
  slug: "native-sdd",
  kind: "answer" in record ? "question" : "assumption",
  handle: record.handle,
  ...("answer" in record ? { question: record } : { assumption: record }),
});
const files = {
  "/edit.json": JSON.stringify({
    kind: "question",
    text: "Which retention period?",
  }),
  "/successor.json": JSON.stringify({
    operationId: "operation-seen",
    reason: "Premise changed",
    text: "Postgres is authoritative.",
    attachment: { kind: "spec" },
    citations: { kind: "clear" },
  }),
};
const postBody = (request: { init: { body?: string } } | undefined): unknown =>
  JSON.parse(request?.init.body ?? "null");

describe("native attention writes", () => {
  it("preserves the caller record version when committing an attention edit", async () => {
    const test = createCcRuntimeFixture({
      files,
      respond: (request) =>
        request.init.method === "GET"
          ? jsonReply(target(question))
          : jsonReply(receipt),
    });
    const args = [
      "native-sdd",
      "Q1",
      "--if-version",
      "3",
      "--file",
      "/edit.json",
    ];
    const result = await test.run(["spec", "attention", "edit", ...args]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      postBody(test.requests.find((request) => request.init.method === "POST")),
    ).toEqual({
      recordId: question.id,
      expectedRecordVersion: 3,
      payload: { kind: "question", text: "Which retention period?" },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { newRecordVersion: 4, previousRecordVersion: 3 } },
    });
  });

  it("refuses payload/record kind mismatch before writing", async () => {
    const test = createCcRuntimeFixture({
      files,
      respond: () => jsonReply(target(assumption)),
    });
    const result = await test.run([
      "spec",
      "attention",
      "edit",
      "native-sdd",
      "A1",
      "--if-version",
      "4",
      "--file",
      "/edit.json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("payload declares question");
    expect(
      test.requests.every((request) => request.init.method === "GET"),
    ).toBe(true);
  });

  it("requires citation version for explicit replacement and leaves every token caller-owned", async () => {
    const payload = {
      kind: "assumption",
      text: "Updated premise",
      citationIntent: {
        kind: "replace",
        revisionId: "draft-payload",
        elementHandles: ["R1"],
      },
    };
    const test = createCcRuntimeFixture({
      files: { "/edit.json": JSON.stringify(payload) },
      respond: (request) =>
        request.init.method === "GET"
          ? jsonReply(target(assumption))
          : jsonReply(
              {
                error: "Record changed",
                code: "stale_record",
                instruction: "Read A1 and rebase the edit.",
              },
              409,
            ),
    });
    const args = [
      "spec",
      "attention",
      "edit",
      "native-sdd",
      "A1",
      "--if-version",
      "4",
      "--file",
      "/edit.json",
    ];
    const refused = await test.run(args);
    expect(refused.exitCode).toBe(2);
    expect(refused.stdout).toContain("if-citation-version");
    const result = await test.run([...args, "--if-citation-version", "2"]);
    expect(
      postBody(test.requests.find((request) => request.init.method === "POST")),
    ).toEqual({
      recordId: assumption.id,
      expectedRecordVersion: 4,
      expectedCitationVersion: 2,
      payload,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Read A1 and rebase the edit.",
    });
  });

  it("sends withdrawal prose with the observed record version", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "GET"
          ? jsonReply(target(question))
          : jsonReply({
              ...receipt,
              operation: "withdrawn",
              lifecycle: "withdrawn",
            }),
    });
    const result = await test.run([
      "spec",
      "attention",
      "withdraw",
      "native-sdd",
      "Q1",
      "--if-version",
      "3",
      "--reason",
      "Question no longer applies\n",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(postBody(test.requests[1])).toEqual({
      recordId: question.id,
      expectedRecordVersion: 3,
      reason: "Question no longer applies\n",
    });
  });

  it.each([false, true])(
    "preserves supersession operation identity and avoids rebinding replays: %s",
    async (replay) => {
      const record = {
        ...assumption,
        supersededByHandle: replay ? "A2" : null,
      };
      const resultReceipt = {
        ...receipt,
        operation: "superseded",
        recordKind: "assumption",
        recordId: assumption.id,
        recordHandle: "A1",
        previousRecordVersion: 4,
        newRecordVersion: 5,
        lifecycle: "withdrawn",
        draftRevisionId: "draft-seen",
        previousCitationVersion: 2,
        newCitationVersion: 3,
        successor: { id: "successor-one", handle: "A2" },
        idempotentReplay: replay,
      };
      const test = createCcRuntimeFixture({
        files,
        respond: (request) =>
          request.init.method === "GET"
            ? jsonReply(target(record))
            : jsonReply(resultReceipt),
      });
      const result = await test.run([
        "spec",
        "attention",
        "supersede",
        "native-sdd",
        "A1",
        "--if-version",
        "4",
        "--if-citation-version",
        "2",
        "--file",
        "/successor.json",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(postBody(test.requests[1])).toEqual({
        assumptionId: assumption.id,
        ...(replay ? {} : { draftRevisionId: "draft-seen" }),
        expectedRecordVersion: 4,
        expectedCitationVersion: 2,
        payload: JSON.parse(files["/successor.json"]),
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        recovery: {
          references: expect.arrayContaining([
            { kind: "spec-assumption", id: "successor-one" },
          ]),
        },
      });
    },
  );

  it.each(["cite", "uncite"])(
    "%s binds the caller revision and citation version without substituting current draft tokens",
    async (operation) => {
      const test = createCcRuntimeFixture({
        respond: (request) =>
          request.init.method === "GET"
            ? jsonReply(target(assumption))
            : jsonReply({
                ...receipt,
                operation: operation === "cite" ? "cited" : "uncited",
                recordKind: "assumption",
                recordId: assumption.id,
                recordHandle: "A1",
                previousRecordVersion: 4,
                newRecordVersion: 4,
                lifecycle: "proposed",
                draftRevisionId: "draft-caller",
                previousCitationVersion: 7,
                newCitationVersion: 8,
              }),
      });
      const result = await test.run([
        "spec",
        "attention",
        operation,
        "native-sdd",
        "A1",
        "--element",
        "native-sdd/R1",
        "--revision",
        "draft-caller",
        "--if-citation-version",
        "7",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(postBody(test.requests[1])).toEqual({
        assumptionId: assumption.id,
        revisionId: "draft-caller",
        elementHandle: "R1",
        expectedCitationVersion: 7,
      });
    },
  );

  it("rejects a citation to another spec without HTTP", async () => {
    const test = createCcRuntimeFixture({ respond: () => jsonReply({}) });
    const result = await test.run([
      "spec",
      "attention",
      "cite",
      "native-sdd",
      "A1",
      "--element",
      "other/R1",
      "--revision",
      "draft-caller",
      "--if-citation-version",
      "7",
    ]);
    expect(result.exitCode).toBe(2);
    expect(test.requests).toEqual([]);
  });
});
