import { describe, expect, it } from "vitest";

import { runCcWithHost, inlineDataOf } from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

/**
 * Behaviour of the checkpoint CLI leaves, driven through the real dispatch.
 *
 * The assertions that matter most are about what the CLI DOES NOT do: a
 * mutation that misses its scope must not repeat itself in the neighbouring
 * one, a preflight must issue no mutation at all, and a `--wait` whose budget
 * runs out must leave the server's operation alone. Those are checked against
 * the recorded request log rather than the rendered text, because the text is
 * not what would corrupt a conversation.
 */

const sessionEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "self-conv",
};

const projectEnv: CliEnv = {
  ...sessionEnv,
  CC_CONVERSATION_SCOPE: "project",
  CC_SESSION: "",
};

interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface TestHost extends CliHost {
  requests: RecordedRequest[];
}

function makeHost(
  respond: (req: RecordedRequest, index: number) => Response,
  options: { nowStep?: number } = {},
): TestHost {
  const requests: RecordedRequest[] = [];
  let clock = 0;
  return {
    requests,
    async fetch(url: string, init: FetchInit) {
      const req: RecordedRequest = {
        url,
        path: new URL(url).pathname + new URL(url).search,
        method: (init.method ?? "GET").toUpperCase(),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(req);
      return respond(req, requests.length - 1);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    now() {
      clock += options.nowStep ?? 0;
      return clock;
    },
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const SESSION_BASE =
  "/api/projects/cc/sessions/my-session/conversations/conv-1";
const PROJECT_BASE = "/api/projects/cc/conversations/conv-1";

interface ReceiptOverrides {
  phase?: string;
  operationId?: string;
  ordinal?: number;
  scope?: "session" | "project";
  seedText?: string;
  omissions?: { category: string; detail: string }[];
  failure?: { code: string; message: string } | null;
  hasAcceptedContinuation?: boolean;
  delivery?: {
    attemptId: string;
    inputFingerprint: string;
    submittedInputFingerprint: string;
    queuedAttemptId: string | null;
    queuedMessageId: string | null;
  } | null;
}

function makeReceipt(overrides: ReceiptOverrides = {}) {
  return {
    operationId: overrides.operationId ?? "op-1",
    mechanism: "cc_checkpoint",
    scope: overrides.scope ?? "session",
    conversationId: "conv-1",
    ordinal: overrides.ordinal ?? 3,
    phase: overrides.phase ?? "building",
    lastStablePhase: null,
    boundary: { capturedThroughSeq: 148, sourceHash: "src-hash" },
    checkpoint: {
      checkpointId: "op-1",
      schemaVersion: 1,
      seedSha256: "seed-hash",
      sectionBytes: {
        total: 18234,
        workingState: 12000,
        recentDialogue: 5000,
        recoveryFraming: 1234,
      },
      omissions: overrides.omissions ?? [
        { category: "evidence_map", detail: "trimmed 3 entries" },
      ],
      versions: {
        generatorVersion: "g1",
        builderVersion: "b1",
        normalizerVersion: "n1",
      },
      artifactProvenance: null,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    delivery: overrides.delivery ?? null,
    acceptance: null,
    hasAcceptedContinuation: overrides.hasAcceptedContinuation ?? false,
    failure: overrides.failure ?? null,
    recoversOperationId: null,
    supersededByOperationId: null,
    generationPassCount: 2,
    compactionUsage: {
      inputTokens: 1200,
      cachedInputTokens: null,
      outputTokens: 340,
      costUsd: null,
      durationMs: 4200,
    },
    seedTokenEstimate: null,
    contextOccupancy: null,
    requestedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  };
}

function refusalResponse(
  code: string,
  reason: string,
  status: number,
  extra: { operationId?: string | null; phase?: string | null } = {},
): Response {
  return jsonResponse(
    {
      error: reason,
      code,
      refusal: {
        code,
        reason,
        operationId: extra.operationId ?? null,
        phase: extra.phase ?? null,
      },
    },
    status,
  );
}

function envelope(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("cctl conversation compact-context", () => {
  it("starts a durable operation with one request UUID and reports its actual phase", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          outcome: "admitted",
          receipt: makeReceipt({ phase: "building" }),
          statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
        },
        202,
      ),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]?.method).toBe("POST");
    expect(host.requests[0]?.path).toBe(`${SESSION_BASE}/checkpoints`);
    const body = host.requests[0]?.body as { requestId: string };
    expect(body.requestId).toMatch(UUID_PATTERN);

    const json = envelope(result.stdout);
    expect(inlineDataOf(result).outcome).toBe("admitted");
    expect(inlineDataOf(result).requestId).toBe(body.requestId);
    // Admission is not readiness: an agent reading this must not send the next
    // message believing the context was already retired.
    expect(JSON.stringify(json)).not.toContain('"phase":"ready"');
  });

  it("mints a different request UUID for each invocation", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      const host = makeHost(() =>
        jsonResponse(
          {
            outcome: "admitted",
            receipt: makeReceipt(),
            statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
          },
          202,
        ),
      );
      await runCcWithHost(
        ["conversation", "compact-context", "conv-1"],
        sessionEnv,
        host,
      );
      seen.push((host.requests[0]?.body as { requestId: string }).requestId);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("passes --recover=through as the superseded operation", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          outcome: "admitted",
          receipt: makeReceipt(),
          statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
        },
        202,
      ),
    );

    await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--recover", "op-old"],
      sessionEnv,
      host,
    );

    expect(host.requests[0]?.body).toMatchObject({
      recoversOperationId: "op-old",
    });
  });

  it("selects the project route at project conversation scope", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          outcome: "admitted",
          receipt: makeReceipt({ scope: "project" }),
          statusUrl: `${PROJECT_BASE}/checkpoints/op-1`,
        },
        202,
      ),
    );

    await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      projectEnv,
      host,
    );

    expect(host.requests[0]?.path).toBe(`${PROJECT_BASE}/checkpoints`);
  });

  it("targets an explicitly named foreign scope", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          outcome: "admitted",
          receipt: makeReceipt(),
          statusUrl: "/x",
        },
        202,
      ),
    );

    await runCcWithHost(
      [
        "conversation",
        "compact-context",
        "conv-1",
        "--project",
        "other",
        "--session",
        "their-session",
      ],
      sessionEnv,
      host,
    );

    expect(host.requests[0]?.path).toBe(
      "/api/projects/other/sessions/their-session/conversations/conv-1/checkpoints",
    );
  });
});

describe("checkpoint mutations never retry in a neighbouring scope", () => {
  const wrongScope = () =>
    jsonResponse(
      { error: "Conversation not found", code: "conversation_not_found" },
      404,
    );

  it("refuses a wrong-scope compact-context and names the explicit-scope command", async () => {
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({
            scope: "session",
            projectName: "other",
            sessionName: "their-session",
          })
        : wrongScope(),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    const posts = host.requests.filter((req) => req.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`${SESSION_BASE}/checkpoints`);
    expect(result.stderr).toContain("--project=other --session=their-session");
  });

  it("names the RECOVERY, not an ordinary start, when a wrong-scope recovery is refused", async () => {
    // Following a suggestion that silently drops `--recover` runs into the
    // recovery gate instead of performing the recovery that was asked for.
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({
            scope: "session",
            projectName: "other",
            sessionName: "their-session",
          })
        : wrongScope(),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--recover", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--recover=op-7");
    expect(result.stderr).toContain("--project=other --session=their-session");
  });

  it("exposes the wrong-scope remedy structurally in JSON", async () => {
    // A JSON caller never reads stderr. A remedy delivered only as a text
    // detail line is a remedy it cannot act on.
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({
            scope: "session",
            projectName: "other",
            sessionName: "their-session",
          })
        : wrongScope(),
    );

    const result = await runCcWithHost(
      [
        "conversation",
        "compact-context",
        "conv-1",
        "--recover",
        "op-7",
        "--json",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    const remedy = envelope(result.stdout).hint;
    expect(remedy).toContain("--recover=op-7");
    expect(remedy).toContain("--project=other --session=their-session");
  });

  it("exposes the wrong-scope cancel remedy structurally in JSON", async () => {
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({ scope: "project", projectName: "other" })
        : wrongScope(),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "cancel", "conv-1", "op-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    const remedy = envelope(result.stdout).hint;
    expect(remedy).toContain("cctl conversation checkpoint cancel");
  });

  it("refuses a wrong-scope cancel without a second mutation", async () => {
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({ scope: "project", projectName: "other" })
        : wrongScope(),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "cancel", "conv-1", "op-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(host.requests.filter((req) => req.method === "POST")).toHaveLength(
      1,
    );
    expect(result.stderr).toContain("--project=other");
  });

  it("still lets a read resolve the owning scope by conversation id", async () => {
    const host = makeHost((req) => {
      if (req.path.startsWith("/api/conversations/")) {
        return jsonResponse({
          scope: "session",
          projectName: "other",
          sessionName: "their-session",
        });
      }
      if (req.path.startsWith(SESSION_BASE)) return wrongScope();
      return jsonResponse({ receipt: makeReceipt({ phase: "ready" }) });
    });

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests.at(-1)?.path).toContain(
      "/api/projects/other/sessions/their-session/conversations/conv-1/checkpoints/op-1",
    );
    expect(host.requests.every((req) => req.method === "GET")).toBe(true);
  });
});

describe("compact-context --wait", () => {
  it("exits 0 on ready and says the next message accepts the seed", async () => {
    let polls = 0;
    const host = makeHost((req) => {
      if (req.method === "POST") {
        return jsonResponse(
          {
            outcome: "admitted",
            receipt: makeReceipt({ phase: "building" }),
            statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
          },
          202,
        );
      }
      polls += 1;
      return jsonResponse({
        receipt: makeReceipt({
          phase: polls < 2 ? "retiring" : "ready",
        }),
      });
    });

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const json = envelope(result.stdout);
    expect((inlineDataOf(result).receipt as { phase: string }).phase).toBe(
      "ready",
    );
    expect(json.effect).toBe("applied");
  });

  it("exits 1 on needs_reconciliation with its rationale and repair command", async () => {
    const host = makeHost((req) =>
      req.method === "POST"
        ? jsonResponse(
            {
              outcome: "admitted",
              receipt: makeReceipt(),
              statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
            },
            202,
          )
        : jsonResponse({
            receipt: makeReceipt({ phase: "needs_reconciliation" }),
          }),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs_reconciliation");
    expect(result.stderr).toContain("why:");
    expect(result.stderr).toContain("cctl conversation checkpoint reconcile");
  });

  it("leaves the operation owned by the server when the client budget runs out", async () => {
    const host = makeHost(
      (req) =>
        req.method === "POST"
          ? jsonResponse(
              {
                outcome: "admitted",
                receipt: makeReceipt(),
                statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
              },
              202,
            )
          : jsonResponse({ receipt: makeReceipt({ phase: "building" }) }),
      // A clock that jumps a full budget per call terminates the wait.
      { nowStep: 1_000_000 },
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.envelope).toHaveProperty("error.code", "CC_OPERATION_FAILED");
    expect(result.envelope).toHaveProperty(
      "error.message",
      expect.stringContaining("timeout"),
    );
    expect(inlineDataOf(result)).toHaveProperty("receipt.operationId", "op-1");
    expect(result.envelope).toHaveProperty(
      "error.continuation",
      expect.objectContaining({
        path: "conversation checkpoint get",
        args: ["conv-1", "op-1"],
      }),
    );
    // Nothing cancels an operation because its watcher stopped watching.
    expect(
      host.requests.filter((req) => req.path.endsWith("/cancel")),
    ).toHaveLength(0);
  });
});

describe("cctl conversation checkpoint check", () => {
  it("reports the eligible transition and issues no mutation", async () => {
    const host = makeHost(() =>
      jsonResponse({
        eligible: true,
        refusals: [],
        active: null,
        hosted: true,
      }),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eligible: true");
    expect(host.requests.every((req) => req.method === "GET")).toBe(true);
    expect(host.requests[0]?.path).toBe(
      `${SESSION_BASE}/checkpoints/eligibility`,
    );
  });

  it("exits 1 and labels each blocker with the transition it blocks", async () => {
    const host = makeHost(() =>
      jsonResponse({
        eligible: false,
        refusals: [
          {
            code: "turn_active",
            reason: "a turn is running",
            operationId: null,
            phase: null,
          },
          {
            code: "checkpoint_pending",
            reason: "another operation holds the slot",
            operationId: "op-9",
            phase: "building",
          },
        ],
        active: makeReceipt({ operationId: "op-9", phase: "building" }),
        hosted: true,
      }),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const details = inlineDataOf(result) as {
      transition: string;
      findings: {
        code: string;
        blocks: string;
        remedy: { path: string; args: Record<string, unknown> };
      }[];
    };
    expect(details.transition).toBe("compact_context");
    expect(details.findings.map((f) => f.code)).toEqual([
      "turn_active",
      "checkpoint_pending",
    ]);
    expect(details.findings.every((f) => f.blocks === "compact_context")).toBe(
      true,
    );
    expect(details.findings[1]?.remedy).toMatchObject({
      path: "conversation checkpoint get",
      args: ["conv-1", "op-9"],
    });
  });

  it("labels findings for the named recovery when --recover=is given", async () => {
    const host = makeHost(() =>
      jsonResponse({
        eligible: false,
        refusals: [
          {
            code: "recovery_target_mismatch",
            reason: "that operation does not require recovery",
            operationId: "op-2",
            phase: "applied",
          },
        ],
        active: null,
        hosted: false,
      }),
    );

    const result = await runCcWithHost(
      [
        "conversation",
        "checkpoint",
        "check",
        "conv-1",
        "--recover",
        "op-2",
        "--json",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.requests[0]?.path).toBe(
      `${SESSION_BASE}/checkpoints/eligibility?recoversOperationId=op-2`,
    );
    const details = inlineDataOf(result) as {
      transition: string;
      findings: { blocks: string }[];
    };
    expect(details.transition).toBe("recovery");
    expect(details.findings[0]?.blocks).toBe("recovery");
    expect(result.envelope).toHaveProperty("error.why");
  });

  it("still refuses at start after a clean check when the state moved", async () => {
    const host = makeHost((req) =>
      req.method === "GET"
        ? jsonResponse({
            eligible: true,
            refusals: [],
            active: null,
            hosted: true,
          })
        : refusalResponse(
            "turn_active",
            "a turn started before the checkpoint reserved",
            409,
          ),
    );

    const clean = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );
    expect(clean.exitCode).toBe(0);

    const started = await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );
    expect(started.exitCode).toBe(1);
    expect(started.stderr).toContain("a turn started before");
  });
});

describe("cctl conversation checkpoint list", () => {
  it("names the exact next-page command in text and JSON alike", async () => {
    const host = makeHost(() =>
      jsonResponse({
        receipts: [
          makeReceipt({ operationId: "op-3", ordinal: 12 }),
          makeReceipt({ operationId: "op-2", ordinal: 11 }),
        ],
        nextBefore: 11,
      }),
    );

    const text = await runCcWithHost(
      ["conversation", "checkpoint", "list", "conv-1", "--limit", "2"],
      sessionEnv,
      host,
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("checkpoint op-3 ordinal=12");
    expect(text.stdout).toContain("checkpoint op-2 ordinal=11");
    expect(text.stdout).toContain("--before=11");
    expect(text.stdout).toContain("--limit=2");

    const json = await runCcWithHost(
      [
        "conversation",
        "checkpoint",
        "list",
        "conv-1",
        "--limit",
        "2",
        "--json",
      ],
      sessionEnv,
      host,
    );
    expect(inlineDataOf(json)).toMatchObject({
      nextBefore: 11,
      omission: {
        total: { kind: "unknown" },
        returned: 2,
        truncated: true,
        reveal: {
          path: "conversation checkpoint list",
          flags: { before: 11, limit: 2 },
        },
      },
    });
  });

  it("reports a complete page as untruncated", async () => {
    const host = makeHost(() =>
      jsonResponse({
        receipts: [makeReceipt({ operationId: "op-1", ordinal: 1 })],
        nextBefore: null,
      }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "list", "conv-1", "--json"],
      sessionEnv,
      host,
    );
    expect(
      (inlineDataOf(result).omission as { truncated: boolean }).truncated,
    ).toBe(false);
    expect(inlineDataOf(result).omission).not.toHaveProperty("reveal");
  });
});

describe("cctl conversation checkpoint get", () => {
  it("reads a FAILED operation successfully and keeps the failure explicit", async () => {
    const host = makeHost(() =>
      jsonResponse({
        receipt: makeReceipt({
          phase: "failed",
          failure: { code: "generation_failed", message: "schema guard" },
        }),
      }),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("phase=failed");
    expect(result.stdout).toContain("generation_failed");
  });

  it("returns the exact frozen seed only when it is asked for", async () => {
    const host = makeHost((req) =>
      req.path.includes("detail=seed")
        ? jsonResponse({
            receipt: makeReceipt({ phase: "ready" }),
            seed: {
              seedText: "FROZEN SEED BYTES",
              seedSha256: "seed-hash",
              schemaVersion: 1,
              createdAt: "2026-09-01T00:00:00.000Z",
            },
          })
        : jsonResponse({ receipt: makeReceipt({ phase: "ready" }) }),
    );

    const receiptOnly = await runCcWithHost(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );
    expect(receiptOnly.stdout).not.toContain("FROZEN SEED BYTES");

    const withSeed = await runCcWithHost(
      [
        "conversation",
        "checkpoint",
        "get",
        "conv-1",
        "op-1",
        "--detail",
        "seed",
      ],
      sessionEnv,
      host,
    );
    expect(withSeed.exitCode).toBe(0);
    expect(withSeed.stdout).toContain("FROZEN SEED BYTES");
  });
});

describe("checkpoint refusal output", () => {
  it("states the deliberate constraint once, with the operation it is about", async () => {
    const host = makeHost(() =>
      refusalResponse(
        "queue_review_required",
        "queued deliveries are unresolved",
        409,
        { operationId: "op-7", phase: "needs_reconciliation" },
      ),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"operationId":"op-7"');
    expect(result.stderr).toContain('"phase":"needs_reconciliation"');
    expect(result.stderr).toContain("why:");
    expect(result.stderr).toContain("never replays uncertain input");
    expect(result.stderr).toContain("cctl conversation compact-context");
  });

  it("mirrors the same facts in JSON", async () => {
    const host = makeHost(() =>
      refusalResponse("recovery_required", "recovery is required", 409, {
        operationId: "op-7",
        phase: "needs_reconciliation",
      }),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.envelope).toHaveProperty(
      "error.details.serverCode",
      "recovery_required",
    );
    expect(result.envelope).toHaveProperty("error.why");
    expect(result.envelope).toHaveProperty(
      "error.details.serverDetails",
      expect.objectContaining({
        refusal: expect.objectContaining({
          operationId: "op-7",
          phase: "needs_reconciliation",
        }),
      }),
    );
    expect(String(result.envelope?.hint)).toContain("--recover=op-7");
  });

  it("keeps the blocking state legible when every hint is ignored", async () => {
    // Hints are advisory (tier 3). An agent that reads none of them must still
    // be able to tell WHAT is blocked and WHY, so the facts live outside them.
    function blockedHost(): TestHost {
      return makeHost(() =>
        refusalResponse(
          "queue_review_required",
          "queued deliveries are unresolved",
          409,
          { operationId: "op-7", phase: "needs_reconciliation" },
        ),
      );
    }

    const text = await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      blockedHost(),
    );
    const withoutHints = text.stderr
      .split("\n")
      .filter((line) => !line.startsWith("hint: "))
      .join("\n");
    expect(withoutHints).not.toBe(text.stderr);
    expect(withoutHints).toContain("queued deliveries are unresolved");
    expect(withoutHints).toContain('"operationId":"op-7"');
    expect(withoutHints).toContain('"phase":"needs_reconciliation"');
    expect(withoutHints).toContain("never replays uncertain input");

    const json = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      blockedHost(),
    );
    const parsed = envelope(json.stdout);
    expect(parsed.hint).toBeTypeOf("string");
    delete parsed["hint"];
    expect(json.envelope).toHaveProperty(
      "error.details.serverCode",
      "queue_review_required",
    );
    expect(json.envelope).toHaveProperty(
      "error.message",
      "queued deliveries are unresolved",
    );
    expect(json.envelope).toHaveProperty(
      "error.why",
      expect.stringContaining("never replays uncertain input"),
    );
    expect(json.envelope).toHaveProperty(
      "error.details.serverDetails",
      expect.objectContaining({
        refusal: expect.objectContaining({
          operationId: "op-7",
          phase: "needs_reconciliation",
        }),
      }),
    );
  });

  it("invents no operation or phase for a pre-admission refusal", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Invalid checkpoint request",
          code: "invalid_checkpoint_request",
          issues: [{ path: "requestId", message: "expected a UUID" }],
        },
        400,
      ),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.envelope).toHaveProperty("error.issues", [
      {
        code: "CC_INPUT_ISSUE",
        path: ["requestId"],
        message: "expected a UUID",
      },
    ]);
    expect(JSON.stringify(result.envelope)).not.toContain("operationId");
    expect(JSON.stringify(result.envelope)).not.toContain("phase");
  });
});

describe("cctl conversation checkpoint reconcile", () => {
  it("separates deterministic repair from the explicit recovery build", async () => {
    const host = makeHost(() =>
      jsonResponse({
        outcome: "repaired",
        receipt: makeReceipt({
          operationId: "op-7",
          phase: "needs_reconciliation",
        }),
      }),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "reconcile", "conv-1", "op-7", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.method).toBe("POST");
    expect(host.requests[0]?.path).toBe(
      `${SESSION_BASE}/checkpoints/op-7/reconcile`,
    );
    expect(inlineDataOf(result).outcome).toBe("repaired");
    expect(String(result.envelope?.hint)).toContain(
      "cctl conversation compact-context",
    );
  });

  it("reports a blocked repair with the operation's own receipt", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "delivery remains unresolved",
          code: "queue_review_required",
          refusal: {
            code: "queue_review_required",
            reason: "delivery remains unresolved",
            operationId: "op-7",
            phase: "needs_reconciliation",
          },
          receipt: makeReceipt({
            operationId: "op-7",
            phase: "needs_reconciliation",
          }),
        },
        409,
      ),
    );

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "reconcile", "conv-1", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"operationId":"op-7"');
    expect(result.stderr).toContain('"phase":"needs_reconciliation"');
    expect(result.stderr).toContain("why:");
  });
});

describe("checkpoint receipts after incomplete observation", () => {
  function admitted(phase = "building"): Response {
    return jsonResponse(
      {
        outcome: "admitted",
        receipt: makeReceipt({ phase }),
        statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
      },
      202,
    );
  }

  it("retains the phase it last observed when the wait budget runs out", async () => {
    function timedOutHost(): TestHost {
      return makeHost(
        (req) =>
          req.method === "POST"
            ? admitted("building")
            : jsonResponse({ receipt: makeReceipt({ phase: "retiring" }) }),
        { nowStep: 1_000_000 },
      );
    }

    const text = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      timedOutHost(),
    );
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("retiring");
    expect(text.stderr).not.toContain("last observed before the timeout");

    const json = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      timedOutHost(),
    );
    expect(inlineDataOf(json)).toHaveProperty("receipt.phase", "retiring");
    expect(json.envelope).toHaveProperty("effect", "applied");
  });

  it("falls back to the admission receipt when no poll was ever readable", async () => {
    const host = makeHost(
      (req) =>
        req.method === "POST"
          ? admitted("building")
          : jsonResponse({ unexpected: true }),
      { nowStep: 1_000_000 },
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(inlineDataOf(result)).toHaveProperty("receipt.phase", "building");
    expect(result.envelope).toHaveProperty("effect", "applied");
  });

  it("keeps delivery and attempt correlation in the failed wait's JSON", async () => {
    const receipt = makeReceipt({
      phase: "needs_reconciliation",
      delivery: {
        attemptId: "att-9",
        inputFingerprint: "fp-in",
        submittedInputFingerprint: "fp-sub",
        queuedAttemptId: "q-att-2",
        queuedMessageId: "q-msg-2",
      },
    });
    const host = makeHost((req) =>
      req.method === "POST" ? admitted() : jsonResponse({ receipt }),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const details = inlineDataOf(result) as {
      receipt: { delivery: { attemptId: string; queuedMessageId: string } };
    };
    expect(details.receipt.delivery.attemptId).toBe("att-9");
    expect(details.receipt.delivery.queuedMessageId).toBe("q-msg-2");
  });
});

/**
 * A suggested MUTATION carries the scope of the conversation it addresses.
 * Reads may resolve another project's conversation by id; the mutations they
 * recommend cannot, so a command printed without scope would be refused — or
 * worse, would act on the caller's own conversation.
 */
describe("checkpoint suggestions carry the resolved target scope", () => {
  function foreignHost(answer: (req: RecordedRequest) => Response): TestHost {
    return makeHost((req) => {
      if (req.path.startsWith("/api/conversations/")) {
        return jsonResponse({
          scope: "session",
          projectName: "other",
          sessionName: "their-session",
        });
      }
      if (req.path.startsWith(SESSION_BASE)) {
        return jsonResponse(
          { error: "Conversation not found", code: "conversation_not_found" },
          404,
        );
      }
      return answer(req);
    });
  }

  const FOREIGN_SCOPE = "--project=other --session=their-session";

  it("scopes the start command a clean eligibility check suggests", async () => {
    const host = foreignHost(() =>
      jsonResponse({
        eligible: true,
        refusals: [],
        active: null,
        hosted: true,
      }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FOREIGN_SCOPE);
    expect(result.stdout).toContain("cctl conversation compact-context");
    expect(result.stdout).toContain("-- conv-1");
  });

  it("scopes the recovery command a named recovery check suggests", async () => {
    const host = foreignHost(() =>
      jsonResponse({
        eligible: true,
        refusals: [],
        active: null,
        hosted: true,
      }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1", "--recover", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(FOREIGN_SCOPE);
    expect(result.stdout).toContain("cctl conversation compact-context");
    expect(result.stdout).toContain("-- conv-1");
  });

  it("scopes the recovery remedy a blocker names", async () => {
    const host = foreignHost(() =>
      jsonResponse({
        eligible: false,
        hosted: true,
        active: null,
        refusals: [
          {
            code: "recovery_required",
            reason: "an operation needs recovery",
            operationId: "op-7",
            phase: "needs_reconciliation",
          },
        ],
      }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(FOREIGN_SCOPE);
    expect(result.stderr).toContain("cctl conversation compact-context");
    expect(result.stderr).toContain("-- conv-1");
  });

  it("scopes the start command an empty list suggests", async () => {
    const host = foreignHost(() =>
      jsonResponse({ receipts: [], nextBefore: null }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "list", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(String(envelope(result.stdout).hint)).toContain(FOREIGN_SCOPE);
    expect(String(envelope(result.stdout).hint)).toContain(
      "cctl conversation compact-context",
    );
    expect(String(envelope(result.stdout).hint)).toContain("-- conv-1");
  });

  it("scopes the reconcile command a failed wait suggests", async () => {
    const host = makeHost((req) =>
      req.method === "POST"
        ? jsonResponse(
            {
              outcome: "admitted",
              receipt: makeReceipt(),
              statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
            },
            202,
          )
        : jsonResponse({
            receipt: makeReceipt({ phase: "needs_reconciliation" }),
          }),
    );

    const result = await runCcWithHost(
      [
        "conversation",
        "compact-context",
        "conv-1",
        "--project",
        "other",
        "--session",
        "their-session",
        "--wait",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(FOREIGN_SCOPE);
    expect(result.stderr).toContain("cctl conversation checkpoint reconcile");
    expect(result.stderr).toContain("-- conv-1");
  });

  it("names the conversation and its scope in a cancelled wait's remedy", async () => {
    const host = makeHost((req) =>
      req.method === "POST"
        ? jsonResponse(
            {
              outcome: "admitted",
              receipt: makeReceipt(),
              statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
            },
            202,
          )
        : jsonResponse({ receipt: makeReceipt({ phase: "cancelled" }) }),
    );

    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    // A bare `compact-context` would checkpoint the CALLER's conversation.
    expect(result.stderr).toContain(
      "cctl conversation compact-context --project=cc --session=my-session -- conv-1",
    );
  });

  it("scopes the explicit recovery a settled reconcile still needs", async () => {
    const host = makeHost(() =>
      jsonResponse({
        outcome: "repaired",
        receipt: makeReceipt({
          operationId: "op-7",
          phase: "needs_reconciliation",
        }),
      }),
    );

    const result = await runCcWithHost(
      [
        "conversation",
        "checkpoint",
        "reconcile",
        "conv-1",
        "op-7",
        "--project",
        "other",
        "--session",
        "their-session",
        "--json",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(String(envelope(result.stdout).hint)).toContain(FOREIGN_SCOPE);
    expect(String(envelope(result.stdout).hint)).toContain(
      "cctl conversation compact-context",
    );
    expect(String(envelope(result.stdout).hint)).toContain("-- conv-1");
  });

  it("scopes the reconcile remedy a reconciliation_failed refusal names", async () => {
    const host = makeHost(() =>
      refusalResponse("reconciliation_failed", "repair did not settle", 409, {
        operationId: "op-7",
        phase: "needs_reconciliation",
      }),
    );

    const result = await runCcWithHost(
      [
        "conversation",
        "checkpoint",
        "reconcile",
        "conv-1",
        "op-7",
        "--project",
        "other",
        "--session",
        "their-session",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(FOREIGN_SCOPE);
    expect(result.stderr).toContain("cctl conversation checkpoint reconcile");
    expect(result.stderr).toContain("-- conv-1");
  });
});

/**
 * What a receipt claims about delivery. "No acceptance" and "never delivered"
 * are different states, and a needs_reconciliation operation with an attempted
 * delivery is exactly the case where conflating them is dangerous.
 */
describe("checkpoint acceptance facts", () => {
  it("does not claim non-delivery when an attempt was made", async () => {
    const receipt = makeReceipt({
      phase: "needs_reconciliation",
      delivery: {
        attemptId: "att-9",
        inputFingerprint: "fp-in",
        submittedInputFingerprint: "fp-sub",
        queuedAttemptId: null,
        queuedMessageId: null,
      },
    });
    const host = makeHost(() => jsonResponse({ receipt }));

    const result = await runCcWithHost(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("has not been delivered");
    expect(result.stdout).toContain("att-9");
    expect(result.stdout).toContain("unconfirmed");
  });

  it("still states plain non-delivery when nothing was attempted", async () => {
    const host = makeHost(() =>
      jsonResponse({ receipt: makeReceipt({ phase: "ready" }) }),
    );
    const result = await runCcWithHost(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );
    expect(result.stdout).toContain("not been delivered");
  });

  it("keeps the refusal code in text, not only in the JSON envelope", async () => {
    const host = makeHost(() =>
      refusalResponse(
        "backend_unsupported",
        "this backend has no checkpoint capability",
        409,
        {
          operationId: null,
          phase: null,
        },
      ),
    );
    const result = await runCcWithHost(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"serverCode":"backend_unsupported"');
  });
});

describe.each([sessionEnv, projectEnv])(
  "checkpoint fork in scope $CC_CONVERSATION_SCOPE",
  (env) => {
    const request = {
      requestId: "12345678-1234-4234-8234-123456789abc",
      name: "Next phase",
      task: "Implement ticket 131",
      relatedWork: { kind: "ticket", ticketNumber: 131 },
      backend: "codex",
      modelSelection: { modelId: "gpt-6-astra", parameters: {} },
    };
    it("fork preflights and submits its model selection to the source scope", async () => {
      const host = makeHost((req) =>
        jsonResponse(
          req.path.endsWith("/check")
            ? { eligible: true }
            : {
                conversation: { id: request.requestId },
                reused: false,
                receipt: makeReceipt({
                  operationId: request.requestId,
                  phase: "ready",
                }),
              },
        ),
      );
      host.readTextFile = async () => JSON.stringify(request);
      const result = await runCcWithHost(
        [
          "conversation",
          "checkpoint",
          "fork",
          "conv-1",
          "op-1",
          "--file",
          "fork.json",
          "--json",
        ],
        env,
        host,
      );
      expect(host.requests).toHaveLength(2);
      for (const [index, observed] of host.requests.entries())
        expect(observed).toMatchObject({
          path: `${env === projectEnv ? PROJECT_BASE : SESSION_BASE}/checkpoints/op-1/fork${index === 0 ? "/check" : ""}`,
          method: "POST",
          body: request,
        });
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({
        effect: "applied",
      });
      expect(result.stdout).toContain(request.requestId);
    });
    it("rejects incomplete atomic model input before connecting", async () => {
      const host = makeHost(() => jsonResponse({ eligible: true }));
      host.readTextFile = async () =>
        JSON.stringify({ ...request, modelSelection: {} });
      const result = await runCcWithHost(
        [
          "conversation",
          "checkpoint",
          "fork",
          "conv-1",
          "op-1",
          "--file",
          "fork.json",
          "--json",
        ],
        env,
        host,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr + result.stdout).toContain("modelSelection");
      expect(host.requests).toHaveLength(0);
    });
  },
);
