import { CHECKPOINT_CAPTURE_POLICY } from "@/lib/conversation-checkpoints/receipt";
import { describe, expect, it } from "vitest";
import { milliseconds } from "cli-for-agents";
import { runCli } from "cli-for-agents/runtime";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const base =
  "/api/projects/project-one/sessions/session-one/conversations/other";
const emptyTruncation = {
  omittedAfter: null,
  partialEntry: null,
  excerptedEntries: [],
  excerptedEntriesOmitted: 0,
  excerptedEntriesNext: null,
};
const transcript = {
  conversationId: "other",
  totalMessages: 1,
  maxSeq: 2,
  units: [
    {
      ref: { messageIndex: 0, messageId: null, seqStart: 0, seqEnd: 2 },
      entrySeqs: [0, 1, 2],
      role: "assistant",
      timestamp: "2026-09-01",
      lines: ["hello"],
    },
  ],
  truncated: false,
  omissions: {
    thinkingOmitted: 0,
    toolResultBytesElided: 0,
    unitsOutsideWindow: 0,
  },
  boundaries: {
    entries: [],
    totalInRange: 0,
    nextBefore: null,
    indexCommand: null,
  },
  truncation: emptyTruncation,
};
const artifact = {
  id: "artifact-one",
  kind: "conversation_compaction",
  status: "complete",
  messageIndex: null,
  coveredStartSeq: 0,
  coveredEndSeq: 2,
  stale: false,
  staleBehindMessages: 0,
  outdated: false,
  updatedAt: "2026-09-01",
};

it("keeps an explicit server in the checkpoint follow-up after returning to ambient identity", async () => {
  const test = createCcRuntimeFixture({
    respond: (request) =>
      request.init.method === "POST"
        ? jsonReply({
            outcome: "admitted",
            receipt: receipt(),
            statusUrl: `${base}/checkpoints/operation-one`,
          })
        : jsonReply({ receipt: receipt() }),
  });
  const started = await test.run([
    "conversation",
    "compact-context",
    "other",
    "--server",
    "http://other.test",
  ]);
  expect(started.exitCode, started.stdout).toBe(0);
  const wire = JSON.parse(started.stdout);
  expect(wire.hint).toContain("--server=http://other.test");
  // All fixture target tokens are unquoted ASCII, so this executes the emitted command exactly.
  const command = String(wire.hint).split("cctl ")[1];
  if (!command) throw new Error("Missing checkpoint follow-up");
  const observed = await test.run(command.split(" "));
  expect(observed.exitCode, observed.stdout).toBe(0);
  expect(test.requests.map((request) => new URL(request.url).origin)).toEqual([
    "http://other.test",
    "http://other.test",
  ]);
});

it("retains an explicit server when executing a checkpoint refusal's recovery command", async () => {
  const test = createCcRuntimeFixture({
    respond: (request) =>
      String(request.init.body).includes('"recoversOperationId":"previous"')
        ? jsonReply({
            outcome: "admitted",
            receipt: receipt(),
            statusUrl: `${base}/checkpoints/operation-one`,
          })
        : jsonReply(
            {
              error: "recovery is required",
              code: "recovery_required",
              refusal: {
                code: "recovery_required",
                reason: "recovery is required",
                operationId: "previous",
                phase: "failed",
              },
            },
            409,
          ),
  });
  const refused = await test.run([
    "conversation",
    "compact-context",
    "other",
    "--server",
    "http://other.test",
  ]);
  expect(refused.exitCode).not.toBe(0);
  const wire = JSON.parse(refused.stdout);
  expect(wire.hint).toContain("--server=http://other.test");
  const command = String(wire.hint).split("cctl ")[1];
  if (!command) throw new Error("Missing checkpoint recovery command");
  const recovered = await test.run(command.split(" "));
  expect(recovered.exitCode, recovered.stdout).toBe(0);
  expect(test.requests.map((request) => new URL(request.url).origin)).toEqual([
    "http://other.test",
    "http://other.test",
  ]);
});

function receipt(phase = "building") {
  return {
    operationId: "operation-one",
    mechanism: "cc_checkpoint",
    handoff: null,
    scope: "session",
    conversationId: "other",
    ordinal: 1,
    phase,
    lastStablePhase: null,
    boundary: { capturedThroughSeq: 2, sourceHash: "hash" },
    checkpoint: null,
    delivery: null,
    acceptance: null,
    hasAcceptedContinuation: false,
    failure: null,
    recoversOperationId: null,
    supersededByOperationId: null,
    generationPassCount: null,
    compactionUsage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    },
    seedTokenEstimate: null,
    contextOccupancy: null,
    requestedAt: "2026-09-01",
    updatedAt: "2026-09-01",
  };
}
const forkRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  name: "Follow up",
  task: "Continue the investigation",
  relatedWork: { kind: "ticket", ticketNumber: 7 },
  backend: "claude",
  modelSelection: { modelId: "sonnet", parameters: { thinking: "high" } },
};

describe("native conversation runtime", () => {
  it("resolves a bare cross-scope read once and preserves audit identity and bounded recovery", async () => {
    const truncation = {
      ...emptyTruncation,
      omittedAfter: {
        nextSeq: 3,
        lastSeq: 9,
        unitCount: 2,
        command: "cctl conversation read other --seq-range 3:9",
      },
    };
    const test = createCcRuntimeFixture({
      respond: ({ url }) => {
        const path = new URL(url).pathname;
        if (path === `${base}/read`)
          return jsonReply(
            { error: "Conversation not found", code: "conversation_not_found" },
            404,
          );
        if (path === "/api/conversations/other")
          return jsonReply({ scope: "project", projectName: "owner" });
        return jsonReply({ ...transcript, truncated: true, truncation });
      },
    });
    const result = await test.run([
      "conversation",
      "read",
      "other",
      "--seq-range",
      "0:9",
      "--include-tools",
      "full",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { transcript: { truncation } } },
    });
    expect(
      test.requests.map((request) => new URL(request.url).pathname),
    ).toEqual([
      `${base}/read`,
      "/api/conversations/other",
      "/api/projects/owner/conversations/other/read",
    ]);
    expect(
      new URL(test.requests[2]?.url ?? "").searchParams.get("includeTools"),
    ).toBe("full");
    expect(test.requests[2]?.init.headers["x-cc-conversation-id"]).toBe(
      "conversation-one",
    );
  });

  it("respects explicit project scope and never retries a mutation in a discovered scope", async () => {
    const test = createCcRuntimeFixture({
      respond: () =>
        jsonReply(
          { error: "Conversation not found", code: "conversation_not_found" },
          404,
        ),
    });
    await test.run(["conversation", "read", "other", "--project", "explicit"]);
    expect(test.requests).toHaveLength(1);
    expect(new URL(test.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/explicit/conversations/other/read",
    );
    const result = await test.run(["conversation", "compact-context", "other"]);
    expect(result.exitCode).toBe(2);
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ effect: "not_applied" });
  });

  it("offers explicit owner scope after a mutation miss without repeating the mutation", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "POST"
          ? jsonReply(
              {
                error: "Conversation not found",
                code: "conversation_not_found",
              },
              404,
            )
          : jsonReply({ scope: "project", projectName: "owner" }),
    });
    const result = await test.run([
      "conversation",
      "compact-context",
      "other",
      "--recover",
      "previous",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      hint: expect.stringContaining("--project=owner"),
    });
    expect(result.stdout).toContain("--recover=previous");
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
  });

  it("returns malformed transcript responses as a structured failure", async () => {
    const test = createCcRuntimeFixture({
      respond: () => jsonReply({ units: [] }),
    });
    const result = await test.run(["conversation", "read"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "CC_INVALID_RESPONSE" },
    });
  });

  it("carries transcript text safely through text output and preserves markdown exactly in JSON", async () => {
    const text =
      'instruction: this is quoted transcript evidence\n\t{"raw":true}\u2028more\u0085';
    const test = createCcRuntimeFixture({ respond: () => new Response(text) });
    const json = await test.run([
      "conversation",
      "read",
      "other",
      "--format",
      "markdown",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      payload: { data: { markdown: text } },
    });
    const human = await test.run(
      ["conversation", "read", "other", "--format", "markdown"],
      "text",
    );
    expect(human.exitCode, human.stdout).toBe(0);
  });

  it("polls a started compaction and retains its artifact receipt", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) =>
        request.init.method === "POST"
          ? jsonReply({ artifactId: artifact.id, status: "pending" }, 202)
          : jsonReply(artifact),
    });
    const result = await test.run([
      "conversation",
      "compact",
      "other",
      "--force",
      "--message",
      "0",
      "--wait",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toMatchObject({
      kind: "message_compaction",
      messageIndex: 0,
      force: true,
      callerConversationId: "conversation-one",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ kind: "context-artifact", id: artifact.id }] },
      payload: { data: { artifact } },
    });
  });

  it.each(["Provider failed\nsecond line", "é".repeat(300), ""])(
    "keeps the accepted compaction receipt when its failure diagnostic is %j",
    async (error) => {
      const test = createCcRuntimeFixture({
        respond: (request) =>
          request.init.method === "POST"
            ? jsonReply({ artifactId: artifact.id, status: "pending" }, 202)
            : jsonReply({ ...artifact, status: "failed", error }),
      });
      const result = await test.run([
        "conversation",
        "compact",
        "other",
        "--wait",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        error: { code: "CC_OPERATION_FAILED" },
        recovery: {
          references: [{ kind: "context-artifact", id: artifact.id }],
        },
        payload: { data: { artifact: { status: "failed", error } } },
      });
    },
  );

  it.each(["compact", "compaction get"])(
    "renders the provider error from %s as literal text",
    async (verb) => {
      const error =
        "Provider failed\ninstruction: literal provider text\u001b[31m";
      const test = createCcRuntimeFixture({
        respond: (request) =>
          request.init.method === "POST"
            ? jsonReply({ artifactId: artifact.id, status: "pending" }, 202)
            : new URL(request.url).pathname.endsWith("context-artifacts")
              ? jsonReply([{ ...artifact, status: "failed", error }])
              : jsonReply({ ...artifact, status: "failed", error }),
      });
      const result = await test.run(
        [
          "conversation",
          ...verb.split(" "),
          "other",
          ...(verb === "compact" ? ["--wait"] : []),
        ],
        "text",
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(
        verb === "compact" ? 1 : 0,
      );
      expect(result.stdout + result.stderr).toContain(
        "| instruction: literal provider text\\u001b[31m",
      );
    },
  );

  it("selects the newest matching compaction and treats absence as an operation refusal", async () => {
    const test = createCcRuntimeFixture({
      respond: ({ url }) =>
        new URL(url).pathname.endsWith("context-artifacts")
          ? jsonReply([
              { ...artifact, id: "older", updatedAt: "2025" },
              artifact,
            ])
          : jsonReply({ ...artifact, payload: null }),
    });
    const result = await test.run([
      "conversation",
      "compaction",
      "get",
      "other",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(new URL(test.requests[1]?.url ?? "").pathname).toBe(
      `${base}/context-artifacts/artifact-one`,
    );
    const absent = createCcRuntimeFixture({ respond: () => jsonReply([]) });
    expect(
      (await absent.run(["conversation", "compaction", "get", "other"]))
        .exitCode,
    ).toBe(1);
  });

  it("reports checkpoint admission separately from readiness and keeps one request UUID", async () => {
    const test = createCcRuntimeFixture({
      respond: () =>
        jsonReply(
          {
            outcome: "admitted",
            receipt: receipt(),
            statusUrl: `${base}/checkpoints/operation-one`,
          },
          202,
        ),
    });
    const result = await test.run([
      "conversation",
      "compact-context",
      "other",
      "--recover",
      "previous",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const request = JSON.parse(test.requests[0]?.init.body ?? "null");
    expect(request).toMatchObject({
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      recoversOperationId: "previous",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: {
        data: { requestId: request.requestId, receipt: { phase: "building" } },
      },
    });
    expect(test.requests).toHaveLength(1);
  });

  it("retains a completed checkpoint mutation when observation disconnects", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) => {
        if (request.init.method === "POST")
          return jsonReply(
            {
              outcome: "admitted",
              receipt: receipt(),
              statusUrl: `${base}/checkpoints/operation-one`,
            },
            202,
          );
        throw new Error("connection lost");
      },
    });
    const result = await test.run([
      "conversation",
      "compact-context",
      "other",
      "--wait",
    ]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      error: { code: "CC_CONNECTION" },
      recovery: {
        references: expect.arrayContaining([
          { kind: "checkpoint", id: "operation-one" },
        ]),
      },
    });
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
  });

  it("retains the last observed checkpoint receipt on timeout", async () => {
    const test = createCcRuntimeFixture({
      respond: (request) => {
        if (request.init.method === "POST")
          return jsonReply({
            outcome: "admitted",
            receipt: receipt(),
            statusUrl: `${base}/checkpoints/operation-one`,
          });
        test.kernelHost.advance(milliseconds(900_000));
        return jsonReply({ receipt: receipt("retiring") });
      },
    });
    const result = await test.run([
      "conversation",
      "compact-context",
      "other",
      "--wait",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { receipt: { phase: "retiring" } } },
      error: { message: expect.stringContaining("timeout") },
    });
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
  });

  it("stops checkpoint observation on cancellation without cancelling the server operation", async () => {
    const abort = new AbortController();
    const test = createCcRuntimeFixture({
      respond: (request) => {
        if (request.init.method === "POST")
          return jsonReply({
            outcome: "admitted",
            receipt: receipt(),
            statusUrl: `${base}/checkpoints/operation-one`,
          });
        abort.abort();
        return jsonReply({ receipt: receipt("building") });
      },
    });
    const result = await runCli(test.cli, {
      argv: ["conversation", "compact-context", "other", "--wait", "--json"],
      host: test.kernelHost,
      signal: abort.signal,
      env: {
        CC_SERVER_URL: "http://cc.test",
        CC_API_TOKEN: "test-token",
        CC_PROJECT: "project-one",
        CC_SESSION: "session-one",
        CC_CONVERSATION_ID: "conversation-one",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: {
        references: expect.arrayContaining([
          { kind: "checkpoint", id: "operation-one" },
        ]),
      },
    });
    expect(
      test.requests.filter((request) => request.init.method === "POST"),
    ).toHaveLength(1);
  });

  it.each(["ready", "applied", "failed", "cancelled", "needs_reconciliation"])(
    "observes terminal checkpoint phase %s without remote cancellation",
    async (phase) => {
      const test = createCcRuntimeFixture({
        respond: (request) =>
          request.init.method === "POST"
            ? jsonReply({
                outcome: "admitted",
                receipt: receipt(),
                statusUrl: `${base}/checkpoints/operation-one`,
              })
            : jsonReply({ receipt: receipt(phase) }),
      });
      const result = await test.run([
        "conversation",
        "compact-context",
        "other",
        "--wait",
      ]);
      expect(result.exitCode, result.stdout).toBe(
        ["ready", "applied"].includes(phase) ? 0 : 1,
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: { data: { receipt: { phase } } },
      });
      expect(
        test.requests.filter((request) => request.init.method === "POST"),
      ).toHaveLength(1);
    },
  );

  it("reports eligibility blockers with the transition they block and no mutation", async () => {
    const test = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          eligible: false,
          hosted: true,
          handoff: {
            available: false,
            mode: null,
            reason: "unavailable",
            policy: CHECKPOINT_CAPTURE_POLICY,
          },
          active: receipt(),
          refusals: [
            {
              code: "checkpoint_pending",
              reason: "Checkpoint is building",
              operationId: "operation-one",
              phase: "building",
            },
          ],
        }),
    });
    const result = await test.run([
      "conversation",
      "checkpoint",
      "check",
      "other",
      "--recover",
      "previous",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: {
        data: {
          eligible: false,
          findings: [{ blocks: "recovery", code: "checkpoint_pending" }],
        },
      },
    });
    expect(
      test.requests.every((request) => request.init.method === "GET"),
    ).toBe(true);
  });

  it("carries a real checkpoint page cursor and treats a failed receipt read as successful", async () => {
    const test = createCcRuntimeFixture({
      respond: ({ url }) =>
        new URL(url).pathname.endsWith("checkpoints")
          ? jsonReply({ receipts: [receipt()], nextBefore: 1 })
          : jsonReply({ receipt: receipt("failed"), seed: null }),
    });
    const listed = await test.run([
      "conversation",
      "checkpoint",
      "list",
      "other",
      "--limit",
      "1",
    ]);
    expect(listed.exitCode, listed.stdout).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      payload: {
        data: {
          omission: {
            truncated: true,
            returned: 1,
            total: { kind: "unknown" },
            reveal: {
              path: "conversation checkpoint list",
              flags: { before: 1, limit: 1 },
            },
          },
        },
      },
    });
    const detail = await test.run([
      "conversation",
      "checkpoint",
      "get",
      "other",
      "operation-one",
      "--detail",
      "seed",
    ]);
    expect(detail.exitCode, detail.stdout).toBe(0);
    expect(JSON.parse(detail.stdout)).toMatchObject({
      payload: { data: { receipt: { phase: "failed" }, seed: null } },
    });
  });

  it.each(["cancel", "reconcile"])(
    "executes checkpoint %s once and keeps the receipt",
    async (verb) => {
      const test = createCcRuntimeFixture({
        respond: () =>
          jsonReply({
            outcome: "unchanged",
            receipt: receipt("needs_reconciliation"),
          }),
      });
      const result = await test.run([
        "conversation",
        "checkpoint",
        verb,
        "other",
        "operation-one",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: {
          data: {
            outcome: "unchanged",
            receipt: { phase: "needs_reconciliation" },
          },
        },
      });
      expect(test.requests).toHaveLength(1);
    },
  );

  it("commits a fork only after the server preflight succeeds", async () => {
    const test = createCcRuntimeFixture({
      files: { "/fork.json": JSON.stringify(forkRequest) },
      respond: ({ url }) =>
        new URL(url).pathname.endsWith("/check")
          ? jsonReply({ eligible: true })
          : jsonReply({
              conversation: { id: "fork-one" },
              receipt: receipt("ready"),
              reused: false,
            }),
    });
    const created = await test.run([
      "conversation",
      "checkpoint",
      "fork",
      "other",
      "operation-one",
      "--file",
      "/fork.json",
    ]);
    expect(created.exitCode, created.stdout).toBe(0);
    expect(
      test.requests.map((request) => new URL(request.url).pathname),
    ).toEqual([
      `${base}/checkpoints/operation-one/fork/check`,
      `${base}/checkpoints/operation-one/fork`,
    ]);
    expect(JSON.parse(created.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { conversationId: "fork-one", reused: false } },
    });
  });

  it("rejects malformed fork payloads before contacting the server", async () => {
    const test = createCcRuntimeFixture({
      files: {
        "/fork.json": JSON.stringify({ ...forkRequest, requestId: "invalid" }),
      },
      respond: () => jsonReply({}),
    });
    const result = await test.run([
      "conversation",
      "checkpoint",
      "fork",
      "other",
      "operation-one",
      "--file",
      "/fork.json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("requestId");
    expect(test.requests).toEqual([]);
  });

  it("reads archive entry text without JSON parsing and exports the original image bytes", async () => {
    const body = "{unparsed tool evidence}\n\u2028body";
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const test = createCcRuntimeFixture({
      respond: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes("/images/"))
          return new Response(bytes, {
            headers: { "content-type": "image/png" },
          });
        if (parsed.searchParams.get("format") === "metadata")
          return jsonReply({
            entry: {
              conversationId: "other",
              seq: 2,
              kind: "tool_result",
              role: null,
              entryId: "entry-one",
              timestamp: null,
              messageIndex: 0,
              includeThinking: true,
              thinkingOmitted: 0,
              bytes: new TextEncoder().encode(body).length,
              sha256: "hash",
              images: [],
            },
          });
        return new Response(body);
      },
    });
    const entry = await test.run([
      "conversation",
      "entry",
      "get",
      "other",
      "2",
      "--include-thinking",
    ]);
    expect(entry.exitCode, entry.stdout).toBe(0);
    expect(JSON.parse(entry.stdout)).toMatchObject({
      payload: { data: { text: body, entry: { includeThinking: true } } },
    });
    const image = await test.run([
      "conversation",
      "image",
      "get",
      "other",
      "2",
      "1",
      "--out",
      "/artifacts/original.png",
    ]);
    expect(image.exitCode, image.stdout).toBe(0);
    expect(test.kernelHost.filesSnapshot()["/artifacts/original.png"]).toEqual(
      bytes,
    );
  });
});
