import { describe, expect, it } from "vitest";

import { runCli } from "../../core";
import { STDOUT_BUDGET_BYTES } from "../../disclosure";
import type { CliEnv, CliHost, FetchInit } from "../../shared";

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
  written: { path: string; content: string }[];
}

function makeHost(
  respond: (req: RecordedRequest, index: number) => Response,
  options: { writeTextFile?: CliHost["writeTextFile"]; nowStep?: number } = {},
): TestHost {
  const requests: RecordedRequest[] = [];
  const written: { path: string; content: string }[] = [];
  let clock = 0;
  return {
    requests,
    written,
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
    writeTextFile:
      options.writeTextFile ??
      (async (path: string, content: string) => {
        written.push({ path, content });
      }),
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

    const result = await runCli(
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
    expect(json.outcome).toBe("admitted");
    expect(json.requestId).toBe(body.requestId);
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
      await runCli(
        ["conversation", "compact-context", "conv-1"],
        sessionEnv,
        host,
      );
      seen.push((host.requests[0]?.body as { requestId: string }).requestId);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("passes --recover through as the superseded operation", async () => {
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

    await runCli(
      ["conversation", "compact-context", "conv-1", "--recover", "op-old"],
      sessionEnv,
      host,
    );

    expect(host.requests[0]?.body).toMatchObject({
      recoversOperationId: "op-old",
    });
  });

  it("rejects an empty --recover locally without a request", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--recover", ""],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
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

    await runCli(
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

    await runCli(
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    const posts = host.requests.filter((req) => req.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`${SESSION_BASE}/checkpoints`);
    expect(result.stderr).toContain("--project other --session their-session");
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--recover", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--recover op-7");
    expect(result.stderr).toContain("--project other --session their-session");
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

    const result = await runCli(
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
    const details = envelope(result.stdout).details as Record<string, unknown>;
    expect(details.scopedRemedy).toContain("--recover op-7");
    expect(details.scopedRemedy).toContain(
      "--project other --session their-session",
    );
  });

  it("exposes the wrong-scope cancel remedy structurally in JSON", async () => {
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({ scope: "project", projectName: "other" })
        : wrongScope(),
    );

    const result = await runCli(
      ["conversation", "checkpoint", "cancel", "conv-1", "op-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    const details = envelope(result.stdout).details as Record<string, unknown>;
    expect(details.scopedRemedy).toContain(
      "cctl conversation checkpoint cancel conv-1 op-1 --project other",
    );
  });

  it("refuses a wrong-scope cancel without a second mutation", async () => {
    const host = makeHost((req) =>
      req.path.startsWith("/api/conversations/")
        ? jsonResponse({ scope: "project", projectName: "other" })
        : wrongScope(),
    );

    const result = await runCli(
      ["conversation", "checkpoint", "cancel", "conv-1", "op-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).not.toBe(0);
    expect(host.requests.filter((req) => req.method === "POST")).toHaveLength(
      1,
    );
    expect(result.stderr).toContain("--project other");
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

    const result = await runCli(
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const json = envelope(result.stdout);
    expect((json.receipt as { phase: string }).phase).toBe("ready");
    expect(String(json.hint)).toContain("next ordinary message");
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs_reconciliation");
    expect(result.stderr).toContain("why:");
    expect(result.stderr).toContain(
      "cctl conversation checkpoint reconcile conv-1 op-1",
    );
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const json = envelope(result.stdout);
    expect(json.code).toBe("checkpoint_wait_timeout");
    const details = json.details as { followUp: string; operationId: string };
    expect(details.operationId).toBe("op-1");
    expect(details.followUp).toBe(
      "cctl conversation checkpoint get conv-1 op-1 --project cc --session my-session",
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

    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eligible: compact_context");
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

    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const json = envelope(result.stdout);
    const details = json.details as {
      transition: string;
      findings: { code: string; blocks: string; remedy: string }[];
    };
    expect(details.transition).toBe("compact_context");
    expect(details.findings.map((f) => f.code)).toEqual([
      "turn_active",
      "checkpoint_pending",
    ]);
    expect(
      details.findings.every((f) => f.blocks === "blocks_compact_context"),
    ).toBe(true);
    expect(details.findings[1]?.remedy).toContain(
      "cctl conversation checkpoint get conv-1 op-9",
    );
  });

  it("labels findings for the named recovery when --recover is given", async () => {
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

    const result = await runCli(
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
    const json = envelope(result.stdout);
    const details = json.details as {
      transition: string;
      findings: { blocks: string }[];
    };
    expect(details.transition).toBe("recovery");
    expect(details.findings[0]?.blocks).toBe("blocks_recovery");
    expect(json.rationale).toBeTypeOf("string");
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

    const clean = await runCli(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );
    expect(clean.exitCode).toBe(0);

    const started = await runCli(
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

    const text = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--limit", "2"],
      sessionEnv,
      host,
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("12 total, 2 shown");
    expect(text.stdout).toContain(
      "cctl conversation checkpoint list conv-1 --before 11 --limit 2",
    );

    const json = await runCli(
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
    const parsed = envelope(json.stdout);
    expect(parsed.total).toBe(12);
    expect(parsed.returned).toBe(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nextBefore).toBe(11);
    expect(parsed.reveal).toBe(
      "cctl conversation checkpoint list conv-1 --before 11 --limit 2",
    );
  });

  it("reports a complete page as untruncated", async () => {
    const host = makeHost(() =>
      jsonResponse({
        receipts: [makeReceipt({ operationId: "op-1", ordinal: 1 })],
        nextBefore: null,
      }),
    );
    const result = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--json"],
      sessionEnv,
      host,
    );
    const parsed = envelope(result.stdout);
    expect(parsed.truncated).toBe(false);
    expect(parsed.reveal).toBeUndefined();
  });

  it("rejects a non-integer --limit locally, before any request", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--limit", "many"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
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

    const result = await runCli(
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

    const receiptOnly = await runCli(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      host,
    );
    expect(receiptOnly.stdout).not.toContain("FROZEN SEED BYTES");

    const withSeed = await runCli(
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

  it("rejects an unknown --detail locally", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      [
        "conversation",
        "checkpoint",
        "get",
        "conv-1",
        "op-1",
        "--detail",
        "everything",
      ],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("requires both the conversation and the operation id", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["conversation", "checkpoint", "get", "op-1"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("operation: op-7");
    expect(result.stderr).toContain("phase: needs_reconciliation");
    expect(result.stderr).toContain("why:");
    expect(result.stderr).toContain("never replays uncertain input");
    expect(result.stderr).toContain(
      "cctl conversation compact-context conv-1 --recover op-7",
    );
  });

  it("mirrors the same facts in JSON", async () => {
    const host = makeHost(() =>
      refusalResponse("recovery_required", "recovery is required", 409, {
        operationId: "op-7",
        phase: "needs_reconciliation",
      }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    const json = envelope(result.stdout);
    expect(json.code).toBe("recovery_required");
    expect(json.rationale).toBeTypeOf("string");
    expect(json.details).toMatchObject({
      refusal: { operationId: "op-7", phase: "needs_reconciliation" },
    });
    expect(String(json.hint)).toContain("--recover op-7");
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

    const text = await runCli(
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
    expect(withoutHints).toContain("operation: op-7");
    expect(withoutHints).toContain("phase: needs_reconciliation");
    expect(withoutHints).toContain("never replays uncertain input");

    const json = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      blockedHost(),
    );
    const parsed = envelope(json.stdout);
    expect(parsed.hint).toBeTypeOf("string");
    delete parsed["hint"];
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("queue_review_required");
    expect(parsed.error).toBe("queued deliveries are unresolved");
    expect(parsed.rationale).toContain("never replays uncertain input");
    expect(parsed.details).toMatchObject({
      refusal: { operationId: "op-7", phase: "needs_reconciliation" },
    });
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    const json = envelope(result.stdout);
    expect(json.issues).toEqual([
      { path: "requestId", message: "expected a UUID" },
    ]);
    expect(JSON.stringify(json)).not.toContain("operationId");
    expect(JSON.stringify(json)).not.toContain("phase");
  });

  it("keeps the connection class when the server is unreachable", async () => {
    const host = makeHost(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
  });

  it("keeps the build-skew class", async () => {
    const host = makeHost(
      () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "x-cc-build-mismatch": "server=abc cli=def",
          },
        }),
    );
    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(4);
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

    const result = await runCli(
      ["conversation", "checkpoint", "reconcile", "conv-1", "op-7", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.method).toBe("POST");
    expect(host.requests[0]?.path).toBe(
      `${SESSION_BASE}/checkpoints/op-7/reconcile`,
    );
    const json = envelope(result.stdout);
    expect(json.outcome).toBe("repaired");
    expect(String(json.hint)).toContain(
      "cctl conversation compact-context conv-1 --recover op-7",
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

    const result = await runCli(
      ["conversation", "checkpoint", "reconcile", "conv-1", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("checkpoint op-7");
    expect(result.stderr).toContain("phase=needs_reconciliation");
    expect(result.stderr).toContain("why:");
  });
});

describe("checkpoint output stays inside the stdout budget", () => {
  const hugeSeed = "s".repeat(80_000);

  function seedHost(writeTextFile?: CliHost["writeTextFile"]): TestHost {
    return makeHost(
      () =>
        jsonResponse({
          receipt: makeReceipt({ phase: "ready" }),
          seed: {
            seedText: hugeSeed,
            seedSha256: "seed-hash",
            schemaVersion: 1,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      writeTextFile === undefined ? {} : { writeTextFile },
    );
  }

  it("spills an oversized seed to .cc/temp and reports path, bytes and hash", async () => {
    const host = seedHost();
    const result = await runCli(
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

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(hugeSeed);
    expect(result.stdout).toContain(".cc/temp/");
    expect(result.stdout).toContain("sha256: sha256:");
    expect(host.written).toHaveLength(1);
    expect(host.written[0]?.path.startsWith(".cc/temp/")).toBe(true);
    expect(host.written[0]?.content).toContain(hugeSeed);
  });

  it("discloses the same seed in text and JSON when escaping alone overflows", async () => {
    // Every byte of this seed doubles under JSON escaping, so the two
    // serializations of ONE disclosure level land on opposite sides of the
    // budget. Both must still return the whole seed.
    const quoted = '"'.repeat(40_000);
    function quotedHost(): TestHost {
      return makeHost(() =>
        jsonResponse({
          receipt: makeReceipt({ phase: "ready" }),
          seed: {
            seedText: quoted,
            seedSha256: "seed-hash",
            schemaVersion: 1,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      );
    }
    const argv = [
      "conversation",
      "checkpoint",
      "get",
      "conv-1",
      "op-1",
      "--detail",
      "seed",
    ];

    const textHost = quotedHost();
    const text = await runCli(argv, sessionEnv, textHost);
    expect(textHost.written).toHaveLength(0);
    expect(text.stdout).toContain(quoted);

    const jsonHost = quotedHost();
    const json = await runCli([...argv, "--json"], sessionEnv, jsonHost);
    expect(json.exitCode).toBe(0);
    expect(jsonHost.written).toHaveLength(1);
    expect(Buffer.byteLength(json.stdout, "utf8")).toBeLessThan(2000);

    const spilled = envelope(jsonHost.written[0]?.content ?? "");
    expect(spilled.detail).toBe("seed");
    expect((spilled.seed as { seedText: string }).seedText).toBe(quoted);
    // Both requests asked for the same disclosure level.
    expect(
      [...textHost.requests, ...jsonHost.requests].every((request) =>
        request.path.includes("detail=seed"),
      ),
    ).toBe(true);
  });

  it("measures a multibyte seed in UTF-8 bytes, not code points", async () => {
    // A third of the budget in characters, over it in bytes.
    const snowmen = "\u2603".repeat(25_000);
    const host = makeHost(() =>
      jsonResponse({
        receipt: makeReceipt({ phase: "ready" }),
        seed: {
          seedText: snowmen,
          seedSha256: "seed-hash",
          schemaVersion: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );

    const result = await runCli(
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

    expect(snowmen.length).toBeLessThan(60_000);
    expect(host.written).toHaveLength(1);
    expect(result.stdout).not.toContain(snowmen);
    expect(host.written[0]?.content).toContain(snowmen);
  });

  it("keeps the page's counts and next-page command inside a spilled list", async () => {
    const receipts = Array.from({ length: 100 }, (_, index) =>
      makeReceipt({
        operationId: `op-${"x".repeat(600)}-${100 - index}`,
        ordinal: 100 - index,
      }),
    );
    const host = makeHost(() => jsonResponse({ receipts, nextBefore: 1 }));

    const result = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--limit", "100"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.written).toHaveLength(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    // The manifest replaces the rows, never the accounting: the spilled file
    // still states the window total, what came back and the exact next page.
    const spilled = host.written[0]?.content ?? "";
    expect(spilled).toContain("100 total, 100 shown");
    expect(spilled).toContain(
      "cctl conversation checkpoint list conv-1 --before 1 --limit 100",
    );
  });

  it("preserves a server-side page refusal's structured issues", async () => {
    // `--before` is a cursor the CLI cannot check locally: only the server
    // knows which ordinals exist, so its refusal is the one that must survive.
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "before must address an existing ordinal",
          code: "invalid_cursor",
          issues: [{ path: "before", message: "no ordinal below 1" }],
        },
        400,
      ),
    );

    const result = await runCli(
      [
        "conversation",
        "checkpoint",
        "list",
        "conv-1",
        "--before",
        "1",
        "--json",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    const json = envelope(result.stdout);
    expect(json.code).toBe("invalid_cursor");
    expect(json.issues).toEqual([
      { path: "before", message: "no ordinal below 1" },
    ]);
  });

  it("fails typed and bounded when the spill cannot be written", async () => {
    const host = seedHost(async () => {
      throw new Error("EACCES");
    });
    const result = await runCli(
      [
        "conversation",
        "checkpoint",
        "get",
        "conv-1",
        "op-1",
        "--detail",
        "seed",
        "--json",
      ],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const json = envelope(result.stdout);
    expect(json.code).toBe("write_failed");
    expect(result.stdout).not.toContain(hugeSeed);
    expect(result.stdout.length).toBeLessThan(2000);
  });
});

/**
 * The outcome CLASSES a checkpoint command reports, independent of what it
 * says. A structured build-skew refusal is a build mismatch even though it
 * arrives as a 409 body; a poll that cannot authenticate is an auth failure
 * rather than an unreadable status; and a wait whose budget ran out still
 * knows the phase it last saw.
 */
describe("checkpoint transport and wait outcome classes", () => {
  const SKEW_BODY = {
    error:
      "refused before execution: this cctl is not the build this server published (server build abc) — no changes were made",
    code: "build_skew",
    details: { serverBuild: "abc", serverCliPath: "/srv/cc/bin/cctl" },
  };

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

  it.each([
    ["compact-context", ["conversation", "compact-context", "conv-1"]],
    ["cancel", ["conversation", "checkpoint", "cancel", "conv-1", "op-1"]],
    [
      "reconcile",
      ["conversation", "checkpoint", "reconcile", "conv-1", "op-1"],
    ],
  ])(
    "maps the server's structured build_skew refusal to exit 4 (%s)",
    async (_name, argv) => {
      // No mismatch header: the body IS the refusal, and it is the only signal
      // that the handler never ran.
      const host = makeHost(() => jsonResponse(SKEW_BODY, 409));
      const result = await runCli(argv as string[], sessionEnv, host);
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain("no changes were made");
      expect(result.stderr).toContain("/srv/cc/bin/cctl");
    },
  );

  it("keeps the auth class when a --wait poll is rejected", async () => {
    const host = makeHost((req) =>
      req.method === "POST"
        ? admitted()
        : new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("cctl doctor");
  });

  it("keeps the connection class when a --wait poll cannot reach the server", async () => {
    let polled = false;
    const host = makeHost((req) => {
      if (req.method === "POST") return admitted();
      polled = true;
      throw new Error("ECONNREFUSED");
    });

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(polled).toBe(true);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("cctl doctor");
  });

  it("keeps the build-mismatch class when a --wait poll reads a skewed server", async () => {
    const host = makeHost((req) =>
      req.method === "POST"
        ? admitted()
        : new Response(JSON.stringify({ receipt: makeReceipt() }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-cc-build-mismatch": "server=abc cli=def",
            },
          }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(4);
  });

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

    const text = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      timedOutHost(),
    );
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("phase: retiring");
    expect(text.stderr).not.toContain("last observed before the timeout");

    const json = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      timedOutHost(),
    );
    const parsed = envelope(json.stdout);
    const details = parsed.details as {
      lastObserved: { phase: string; source: string; operationId: string };
      receipt: { phase: string };
    };
    expect(details.lastObserved.phase).toBe("retiring");
    expect(details.lastObserved.source).toBe("polled");
    expect(details.receipt.phase).toBe("retiring");
  });

  it("falls back to the admission receipt when no poll was ever readable", async () => {
    const host = makeHost(
      (req) =>
        req.method === "POST"
          ? admitted("building")
          : jsonResponse({ unexpected: true }),
      { nowStep: 1_000_000 },
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const details = envelope(result.stdout).details as {
      lastObserved: { phase: string; source: string };
    };
    expect(details.lastObserved.phase).toBe("building");
    expect(details.lastObserved.source).toBe("admission");
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const details = envelope(result.stdout).details as {
      receipt: { delivery: { attemptId: string; queuedMessageId: string } };
    };
    expect(details.receipt.delivery.attemptId).toBe("att-9");
    expect(details.receipt.delivery.queuedMessageId).toBe("q-msg-2");
  });

  it("rejects a --limit above the documented maximum before any request", async () => {
    const host = makeHost(() =>
      jsonResponse({ receipts: [], nextBefore: null }),
    );
    const result = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--limit", "500"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
    expect(result.stderr).toContain("100");
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

  const FOREIGN_SCOPE = "--project other --session their-session";

  it("scopes the start command a clean eligibility check suggests", async () => {
    const host = foreignHost(() =>
      jsonResponse({
        eligible: true,
        refusals: [],
        active: null,
        hosted: true,
      }),
    );
    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `cctl conversation compact-context conv-1 ${FOREIGN_SCOPE}`,
    );
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
    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1", "--recover", "op-7"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `cctl conversation compact-context conv-1 --recover op-7 ${FOREIGN_SCOPE}`,
    );
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
    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `cctl conversation compact-context conv-1 --recover op-7 ${FOREIGN_SCOPE}`,
    );
  });

  it("scopes the start command an empty list suggests", async () => {
    const host = foreignHost(() =>
      jsonResponse({ receipts: [], nextBefore: null }),
    );
    const result = await runCli(
      ["conversation", "checkpoint", "list", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(String(envelope(result.stdout).hint)).toContain(
      `cctl conversation compact-context conv-1 ${FOREIGN_SCOPE}`,
    );
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

    const result = await runCli(
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
    expect(result.stderr).toContain(
      `cctl conversation checkpoint reconcile conv-1 op-1 ${FOREIGN_SCOPE}`,
    );
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

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    // A bare `compact-context` would checkpoint the CALLER's conversation.
    expect(result.stderr).toContain(
      "cctl conversation compact-context conv-1 --project cc --session my-session",
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

    const result = await runCli(
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
    expect(String(envelope(result.stdout).hint)).toContain(
      `cctl conversation compact-context conv-1 --recover op-7 ${FOREIGN_SCOPE}`,
    );
  });

  it("scopes the reconcile remedy a reconciliation_failed refusal names", async () => {
    const host = makeHost(() =>
      refusalResponse("reconciliation_failed", "repair did not settle", 409, {
        operationId: "op-7",
        phase: "needs_reconciliation",
      }),
    );

    const result = await runCli(
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
    expect(result.stderr).toContain(
      `cctl conversation checkpoint reconcile conv-1 op-7 ${FOREIGN_SCOPE}`,
    );
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

    const result = await runCli(
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
    const result = await runCli(
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
    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code: backend_unsupported");
  });
});

/**
 * Every checkpoint output — success and failure alike — obeys the same
 * serialized-byte budget. A refusal is not the one path allowed to dump: its
 * error string, its findings and a receipt's omission list are all
 * server-sized, and stdout is what a pipe actually has to hold.
 */
describe("checkpoint output stays inside the shared byte budget", () => {
  const HUGE = "R".repeat(200_000);

  function bigOmissions(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      category: `category_${index}`,
      detail: "d".repeat(10_000),
    }));
  }

  it("spills an oversized refusal instead of dumping it, keeping exit 1", async () => {
    const host = makeHost(() =>
      refusalResponse("conversation_busy", HUGE, 409, {
        operationId: "op-7",
        phase: "building",
      }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(result.stdout).not.toContain(HUGE);
    expect(host.written).toHaveLength(1);
    // The spill carries the refusal complete, and stdout keeps its identity.
    expect(host.written[0]?.content).toContain(HUGE);
    const json = envelope(result.stdout);
    expect(json.code).toBe("conversation_busy");
    // The retained projection is flat because the same value renders as text
    // lines when the body spills; a nested object could not.
    expect(json.details).toMatchObject({
      code: "conversation_busy",
      operation: "op-7",
      phase: "building",
    });
  });

  it("spills an oversized blocked eligibility check, keeping exit 1", async () => {
    const host = makeHost(() =>
      jsonResponse({
        eligible: false,
        hosted: true,
        active: null,
        refusals: Array.from({ length: 20 }, (_, index) => ({
          code: "conversation_busy",
          reason: `${index}-${"b".repeat(5_000)}`,
          operationId: null,
          phase: null,
        })),
      }),
    );

    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(host.written).toHaveLength(1);
    expect(host.written[0]?.content).toContain("blocked: compact_context");
  });

  it("spills an oversized admission receipt, keeping exit 0", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          outcome: "admitted",
          receipt: makeReceipt({ omissions: bigOmissions(20) }),
          statusUrl: `${SESSION_BASE}/checkpoints/op-1`,
        },
        202,
      ),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(host.written).toHaveLength(1);
    expect(envelope(result.stdout).storage).toBe("artifact");
  });

  it("spills an oversized ready wait, keeping exit 0", async () => {
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
            receipt: makeReceipt({
              phase: "ready",
              omissions: bigOmissions(20),
            }),
          }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(host.written).toHaveLength(1);
  });

  it("spills an oversized failed wait, keeping exit 1 and its operation", async () => {
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
            receipt: makeReceipt({
              phase: "needs_reconciliation",
              omissions: bigOmissions(20),
            }),
          }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(host.written).toHaveLength(1);
    const json = envelope(result.stdout);
    expect(json.details).toMatchObject({
      operationId: "op-1",
      phase: "needs_reconciliation",
    });
  });

  it("spills an oversized wait timeout, keeping its operation and last phase", async () => {
    // The timeout reports the newest receipt it actually read, and a receipt
    // observed mid-flight carries the same unbounded omission list every other
    // receipt does. The budget is the same one the terminal outcomes obey.
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
          : jsonResponse({
              receipt: makeReceipt({
                phase: "retiring",
                omissions: bigOmissions(20),
              }),
            }),
      // One poll lands, then the clock jumps a full budget and the wait ends.
      { nowStep: 1_000_000 },
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(host.written).toHaveLength(1);
    // Identity and the last observed phase survive the spill: they are what
    // the caller comes back with, and the follow-up reads the rest.
    const json = envelope(result.stdout);
    expect(json.code).toBe("checkpoint_wait_timeout");
    expect(json.details).toMatchObject({
      operationId: "op-1",
      phase: "retiring",
      followUp:
        "cctl conversation checkpoint get conv-1 op-1 --project cc --session my-session",
    });
    // Nothing cancels an operation because its watcher stopped watching.
    expect(
      host.requests.filter((req) => req.path.endsWith("/cancel")),
    ).toHaveLength(0);
  });

  it("writes a spilled JSON failure as a document that actually parses", async () => {
    // The manifest labels the artifact `json`, and a reader that cannot
    // `JSON.parse` it has been handed a corrupt file by the very mechanism
    // that exists to stop stdout corrupting mid-envelope.
    const host = makeHost(() =>
      refusalResponse("conversation_busy", HUGE, 409, {
        operationId: "op-7",
        phase: "building",
      }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const spilled = host.written[0];
    expect(spilled?.path).toMatch(/\.json$/u);
    const parsed = JSON.parse(spilled?.content ?? "") as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("R");
    // The envelope in stdout announces that file, and it parses too.
    expect(envelope(result.stdout).code).toBe("conversation_busy");
  });

  it("keeps operation, phase, code and rationale in a spilled TEXT refusal", async () => {
    // Text mode never renders the JSON `details`, so a projection kept only
    // there leaves a text caller with a file path and no idea what was
    // refused, on which operation, or why.
    const host = makeHost(() =>
      refusalResponse("queue_review_required", HUGE, 409, {
        operationId: "op-7",
        phase: "needs_reconciliation",
      }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.written).toHaveLength(1);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(
      STDOUT_BUDGET_BYTES,
    );
    expect(result.stderr).toContain("op-7");
    expect(result.stderr).toContain("needs_reconciliation");
    // The deliberate refusal's reason survives the spill with it.
    expect(result.stderr).toMatch(/why:/);
  });

  it("keeps the retained facts when the spill itself cannot be written", async () => {
    const host = makeHost(
      () =>
        refusalResponse("conversation_busy", HUGE, 409, {
          operationId: "op-7",
          phase: "building",
        }),
      {
        writeTextFile: async () => {
          throw new Error("EACCES");
        },
      },
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(HUGE);
    const details = envelope(result.stdout).details as Record<string, unknown>;
    expect(details).toMatchObject({
      code: "conversation_busy",
      operation: "op-7",
      phase: "building",
    });
  });

  it("retains the active operation when a blocked eligibility spills", async () => {
    const host = makeHost(() =>
      jsonResponse({
        eligible: false,
        hosted: true,
        active: makeReceipt({ operationId: "op-9", phase: "retiring" }),
        refusals: Array.from({ length: 20 }, (_, index) => ({
          code: "conversation_busy",
          reason: `${index}-${"b".repeat(5_000)}`,
          operationId: null,
          phase: null,
        })),
      }),
    );

    const result = await runCli(
      ["conversation", "checkpoint", "check", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.written).toHaveLength(1);
    const details = envelope(result.stdout).details as Record<string, unknown>;
    expect(details).toMatchObject({
      activeOperationId: "op-9",
      activePhase: "retiring",
    });
  });

  it("retains the delivery correlations when a failed wait spills", async () => {
    // needs_reconciliation is exactly the state whose recovery depends on
    // which attempt and which queued message carried the seed. Losing those
    // to a spill leaves the caller unable to review the uncertain entry.
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
            receipt: makeReceipt({
              phase: "needs_reconciliation",
              omissions: bigOmissions(20),
              delivery: {
                attemptId: "att-5",
                inputFingerprint: "fp",
                submittedInputFingerprint: "fp",
                queuedAttemptId: "qatt-2",
                queuedMessageId: "qmsg-3",
              },
            }),
          }),
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--wait", "--json"],
      sessionEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.written).toHaveLength(1);
    const details = envelope(result.stdout).details as Record<string, unknown>;
    expect(details).toMatchObject({
      deliveryAttemptId: "att-5",
      queuedAttemptId: "qatt-2",
      queuedMessageId: "qmsg-3",
      acceptance: "unconfirmed",
    });
  });

  it("keeps a spilled failure typed and bounded when the file cannot be written", async () => {
    const host = makeHost(
      () =>
        refusalResponse("conversation_busy", HUGE, 409, {
          operationId: "op-7",
          phase: "building",
        }),
      {
        writeTextFile: async () => {
          throw new Error("EACCES");
        },
      },
    );

    const result = await runCli(
      ["conversation", "compact-context", "conv-1", "--json"],
      sessionEnv,
      host,
    );

    // The refusal's own class survives the spill failure; nothing is dumped.
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).code).toBe("write_failed");
    expect(result.stdout).not.toContain(HUGE);
    expect(result.stdout.length).toBeLessThan(2000);
  });

  it("suggests a byte-bounded read of a spilled checkpoint artifact", async () => {
    const host = makeHost(() =>
      jsonResponse({
        receipt: makeReceipt({ phase: "ready" }),
        seed: {
          seedText: "S".repeat(200_000),
          seedSha256: "sha",
          schemaVersion: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );

    const result = await runCli(
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

    expect(result.exitCode).toBe(0);
    const spilled = Buffer.byteLength(host.written[0]?.content ?? "", "utf8");
    const chunk = /head -c (\d+) /u.exec(result.stdout);
    expect(chunk).not.toBeNull();
    expect(Number(chunk?.[1])).toBeLessThan(spilled);
    expect(result.stdout).not.toContain("sed -n");
  });
});

/**
 * The omission cap has to be revealable. A reveal command that re-applied the
 * same cap would make the ninth category unreachable in text — a cap without
 * disclosure, which is the defect the shared omission type exists to prevent.
 */
describe("checkpoint seed omissions are revealable", () => {
  const TWELVE = Array.from({ length: 12 }, (_, index) => ({
    category: `category_${index}`,
    detail: `detail ${index}`,
  }));

  function omissionHost(): TestHost {
    return makeHost(() =>
      jsonResponse({
        receipt: makeReceipt({ phase: "ready", omissions: TWELVE }),
        seed: {
          seedText: "the frozen seed",
          seedSha256: "sha",
          schemaVersion: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
  }

  it("caps the receipt view and names a reveal that returns the rest", async () => {
    const capped = await runCli(
      ["conversation", "checkpoint", "get", "conv-1", "op-1"],
      sessionEnv,
      omissionHost(),
    );

    expect(capped.stdout).toContain("12 total, 8 shown");
    expect(capped.stdout).toContain("category_7");
    expect(capped.stdout).not.toContain("category_11");

    const reveal = /rest: cctl (.+)/u.exec(capped.stdout)?.[1];
    expect(reveal).toBeTypeOf("string");

    const revealed = await runCli(
      (reveal ?? "").split(" "),
      sessionEnv,
      omissionHost(),
    );

    expect(revealed.exitCode).toBe(0);
    expect(revealed.stdout).toContain("12 total, 12 shown");
    for (const omission of TWELVE) {
      expect(revealed.stdout).toContain(omission.category);
    }
  });

  it("reports the JSON accounting the JSON envelope actually delivers", async () => {
    const result = await runCli(
      ["conversation", "checkpoint", "get", "conv-1", "op-1", "--json"],
      sessionEnv,
      omissionHost(),
    );

    const json = envelope(result.stdout);
    const receipt = json.receipt as {
      checkpoint: { omissions: unknown[] };
    };
    // The envelope carries every omission, so claiming eight were returned
    // would understate what this reader already has.
    expect(receipt.checkpoint.omissions).toHaveLength(12);
    expect(json.seedOmissions).toEqual({
      total: 12,
      returned: 12,
      truncated: false,
    });
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
    it.each(["fork", "fork-check"])(
      "%s submits the exact validated file to the explicit source scope",
      async (verb) => {
        const host = makeHost(() =>
          jsonResponse(
            verb === "fork-check"
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
        const result = await runCli(
          [
            "conversation",
            "checkpoint",
            verb,
            "conv-1",
            "op-1",
            "--file",
            "fork.json",
            "--json",
          ],
          env,
          host,
        );
        expect(host.requests).toHaveLength(1);
        expect(host.requests[0]).toMatchObject({
          path: `${env === projectEnv ? PROJECT_BASE : SESSION_BASE}/checkpoints/op-1/fork${verb === "fork-check" ? "/check" : ""}`,
          method: "POST",
          body: request,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          verb === "fork-check" ? '"eligible":true' : request.requestId,
        );
      },
    );
    it("rejects incomplete atomic model input before connecting", async () => {
      const host = makeHost(() => jsonResponse({ eligible: true }));
      host.readTextFile = async () =>
        JSON.stringify({ ...request, modelSelection: {} });
      const result = await runCli(
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
