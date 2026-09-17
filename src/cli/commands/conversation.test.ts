import { describe, expect, it } from "vitest";
import { runCcWithHost } from "../testing/domain-runtime";
import { type CliEnv, type CliHost, type FetchInit } from "../transport";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "self-conv",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest, index: number) => Response,
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
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
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const sampleTranscript = {
  conversationId: "conv-1",
  totalMessages: 4,
  maxSeq: 21,
  units: [
    {
      ref: { messageIndex: 0, messageId: null, seqStart: 0, seqEnd: 2 },
      entrySeqs: [0, 2],
      role: "user",
      timestamp: "2026-07-01T00:00:00Z",
      lines: ["[s0] fix the bug"],
    },
    {
      ref: { messageIndex: 1, messageId: "m1", seqStart: 3, seqEnd: 9 },
      entrySeqs: [3],
      role: "assistant",
      timestamp: "2026-07-01T00:01:00Z",
      lines: ["[s3] on it"],
    },
  ],
  truncated: false,
  boundaries: {
    entries: [],
    totalInRange: 0,
    nextBefore: null,
    indexCommand: null,
  },
  omissions: {
    thinkingOmitted: 0,
    toolResultBytesElided: 0,
    unitsOutsideWindow: 2,
  },
  truncation: {
    omittedAfter: null,
    partialEntry: null,
    excerptedEntries: [],
    excerptedEntriesOmitted: 0,
    excerptedEntriesNext: null,
  },
};

const conversationArtifact = {
  id: "art-conv",
  kind: "conversation_compaction",
  scope: "session",
  projectPath: "/repo/cc",
  sessionName: "my-session",
  conversationId: "conv-1",
  messageId: null,
  messageIndex: null,
  coveredStartSeq: 0,
  coveredEndSeq: 21,
  sourceHash: "abc",
  status: "complete",
  error: null,
  modelProvider: "claude",
  model: "sonnet",
  effort: null,
  schemaVersion: 1,
  promptVersion: "1",
  normalizerVersion: "1",
  createdBy: "agent",
  createdByConversationId: "self-conv",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:05:00Z",
  stale: false,
  staleBehindMessages: 0,
  outdated: false,
};

const messageArtifact = {
  ...conversationArtifact,
  id: "art-msg",
  kind: "message_compaction",
  messageIndex: 2,
};

describe("cctl conversation read", () => {
  it("GETs the session-scoped read endpoint with mapped query params", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCcWithHost(
      [
        "conversation",
        "read",
        "conv-1",
        "--message-range",
        "0:3",
        "--include-tools",
        "none",
        "--max-bytes",
        "1024",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    const url = new URL(request.url);
    expect(url.pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/read",
    );
    expect(url.searchParams.get("messageRange")).toBe("0:3");
    expect(url.searchParams.get("includeTools")).toBe("none");
    expect(url.searchParams.get("maxBytes")).toBe("1024");
    expect(request.init.method).toBe("GET");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(request.init.headers["x-cc-conversation-id"]).toBe("self-conv");
    expect(result.stdout).toContain("[s0] fix the bug");
  });

  it("defaults the positional to CC_CONVERSATION_ID", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCcWithHost(["conversation", "read"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/self-conv/read",
    );
  });

  it("exits 2 without any conversation id and makes no request", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const env: CliEnv = { ...baseEnv };
    delete env["CC_CONVERSATION_ID"];
    const result = await runCcWithHost(["conversation", "read"], env, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_CONVERSATION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("uses the project-scoped path when --project is given without --session", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCcWithHost(
      ["conversation", "read", "conv-9", "--project", "other"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/other/conversations/conv-9/read",
    );
  });

  it("sends boolean flags as query params and hints the fetch escalation after --outline when a compaction exists", async () => {
    const host = makeHost((req) =>
      req.url.includes("/context-artifacts")
        ? jsonResponse([conversationArtifact])
        : jsonResponse(sampleTranscript),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--outline", "--include-thinking"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("outline")).toBe("true");
    expect(url.searchParams.get("includeThinking")).toBe("true");
    expect(new URL(host.requests[1]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/context-artifacts",
    );
    expect(result.stdout).toContain("cctl conversation compaction get");
  });

  it("hints creating a compaction after --outline when none exists", async () => {
    const host = makeHost((req) =>
      req.url.includes("/context-artifacts")
        ? jsonResponse([])
        : jsonResponse(sampleTranscript),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--outline"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cctl conversation compact");
    expect(result.stdout).not.toContain("compaction get");
  });

  it("hints that compaction is generating after --outline when only a pending artifact exists", async () => {
    const host = makeHost((req) =>
      req.url.includes("/context-artifacts")
        ? jsonResponse([{ ...conversationArtifact, status: "pending" }])
        : jsonResponse(sampleTranscript),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--outline"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("compaction is generating");
    expect(result.stdout).toContain("cctl conversation compaction get");
  });

  it("falls back to the fetch hint when the artifact listing fails, without failing the read", async () => {
    const host = makeHost((req) =>
      req.url.includes("/context-artifacts")
        ? jsonResponse({ error: "boom" }, 500)
        : jsonResponse(sampleTranscript),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--outline"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cctl conversation compaction get");
  });

  it("does not touch the artifacts endpoint on a non-outline read", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(1);
  });

  it("prints raw text for --format markdown", async () => {
    const host = makeHost(
      () =>
        new Response("# transcript\n\nbody\n", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--format", "markdown"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# transcript");
    expect(
      new URL(host.requests[0]?.url ?? "").searchParams.get("format"),
    ).toBe("markdown");
  });

  it("wraps the markdown in the envelope under --json", async () => {
    const host = makeHost(
      () =>
        new Response("# transcript\n", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--format", "markdown", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.markdown).toBe("# transcript\n");
  });

  it("carries the full response body in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.transcript).toEqual(sampleTranscript);
  });

  it("reports truncation instead of 'no matching units' when an oversize unit was elided whole", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleTranscript, units: [], truncated: true }),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("no matching transcript units");
    expect(result.stdout).toContain("truncated");
    expect(result.stdout).toContain("--max-bytes");
  });

  it("teaches the conversation's coordinates on an empty, untruncated window", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleTranscript, units: [], truncated: false }),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", "--message-range", "760:788"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matching transcript units");
    expect(result.stdout).toContain("4 messages (#0..#3)");
    expect(result.stdout).toContain("seqs 0..21");
    expect(result.stdout).toContain("--seq-range");
  });
});

describe("cctl conversation compact", () => {
  it("POSTs create_or_refresh and reports pending with a hint", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifactId: "art-1", status: "pending" }, 202),
    );
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/context-artifacts",
    );
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      kind: "conversation_compaction",
      mode: "create_or_refresh",
      callerConversationId: "self-conv",
    });
    expect(result.stdout).toContain("cctl conversation compaction get");
  });

  it("targets a message compaction with --message and passes --force", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifactId: "art-2", status: "pending" }, 202),
    );
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1", "--message", "3", "--force"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      kind: "message_compaction",
      mode: "create_or_refresh",
      messageIndex: 3,
      force: true,
      callerConversationId: "self-conv",
    });
  });

  // "already fresh" is the outcome, not an advisory next step: it belongs in
  // the primary body (text) and as a status field (JSON), never as a hint.
  it("reports an already-fresh artifact without waiting", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifact: conversationArtifact, hint: "already fresh" }),
    );
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.artifact.id).toBe("art-conv");
    expect(envelope.payload.data.status).toBe("fresh");
    expect(envelope.hint).toBeUndefined();
  });

  it("states the already-fresh outcome as primary text output", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifact: conversationArtifact, hint: "already fresh" }),
    );
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.stdout).toContain(
      "compaction already fresh (artifact art-conv)",
    );
  });

  it("polls the artifact to completion under --wait", async () => {
    const host = makeHost((_req, index) => {
      if (index === 0)
        return jsonResponse({ artifactId: "art-conv", status: "pending" }, 202);
      if (index === 1)
        return jsonResponse({ ...conversationArtifact, status: "pending" });
      return jsonResponse(conversationArtifact);
    });
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1", "--wait", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(3);
    expect(new URL(host.requests[1]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/context-artifacts/art-conv",
    );
    expect(host.requests[1]?.init.method).toBe("GET");
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.artifact.status).toBe("complete");
  });

  it("exits 1 when the awaited compaction fails", async () => {
    const host = makeHost((_req, index) => {
      if (index === 0)
        return jsonResponse({ artifactId: "art-conv", status: "pending" }, 202);
      return jsonResponse({
        ...conversationArtifact,
        status: "failed",
        error: "model returned invalid envelope",
      });
    });
    const result = await runCcWithHost(
      ["conversation", "compact", "conv-1", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("model returned invalid envelope");
  });
});

describe("cctl conversation compaction get", () => {
  it("lists, picks the conversation artifact, and fetches the full envelope", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([messageArtifact, conversationArtifact]);
      return jsonResponse({
        ...conversationArtifact,
        payload: { agentBrief: "the brief" },
      });
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(2);
    expect(new URL(host.requests[1]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/context-artifacts/art-conv",
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.artifact.payload.agentBrief).toBe("the brief");
    expect(envelope.hint).toBeUndefined();
  });

  const samplePayload = {
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "cc",
      sessionName: "my-session",
      conversationId: "conv-1",
      coveredStartSeq: 0,
      coveredEndSeq: 21,
      messageCount: 4,
      sourceHash: "abc",
    },
    agentBrief: "the brief",
    currentState: {
      status: "complete",
      latestUserGoal: "ship it",
      nextBestActions: ["verify live"],
    },
    decisions: [
      {
        statement: "delta accrual",
        status: "accepted",
        sourceRefs: [
          { messageIndex: 1, messageId: null, seqStart: 3, seqEnd: 9 },
        ],
      },
    ],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 2 },
    extras: {},
  };

  it("renders the envelope as prose with --format markdown", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact]);
      return jsonResponse({ ...conversationArtifact, payload: samplePayload });
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1", "--format", "markdown"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Compaction — cc / my-session / conv-1");
    expect(result.stdout).toContain("## Agent brief\nthe brief");
    expect(result.stdout).toContain("1. verify live");
    expect(result.stdout).toContain("#1 s3–9");
  });

  it("carries the markdown in the --json envelope under --format markdown", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact]);
      return jsonResponse({ ...conversationArtifact, payload: samplePayload });
    });
    const result = await runCcWithHost(
      [
        "conversation",
        "compaction",
        "get",
        "conv-1",
        "--format",
        "markdown",
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.markdown).toContain(
      "# Compaction — cc / my-session / conv-1",
    );
  });

  it("reports an unrenderable payload plainly under --format markdown", async () => {
    const pendingArtifact = { ...conversationArtifact, status: "pending" };
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([pendingArtifact]);
      return jsonResponse({ ...pendingArtifact, payload: null });
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1", "--format", "markdown"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no renderable payload");
    expect(result.stdout).toContain("status=pending");
  });

  it("selects the message artifact for --message N", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact, messageArtifact]);
      return jsonResponse({ ...messageArtifact, payload: {} });
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1", "--message", "2"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[1]?.url ?? "").pathname).toContain("/art-msg");
  });

  it("hints a refresh when the artifact is stale", async () => {
    const staleArtifact = {
      ...conversationArtifact,
      stale: true,
      staleBehindMessages: 4,
    };
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([staleArtifact]);
      return jsonResponse({ ...staleArtifact, payload: {} });
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cctl conversation compact");
  });

  it("exits 1 with a create hint when no artifact exists", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cctl conversation compact");
  });

  it("exits 1 with a create hint on a direct artifact_not_found 404", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact]);
      return jsonResponse(
        { error: "Artifact not found", code: "artifact_not_found" },
        404,
      );
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cctl conversation compact");
  });

  it("carries the artifact_not_found code in the --json failure envelope", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact]);
      return jsonResponse(
        { error: "Artifact not found", code: "artifact_not_found" },
        404,
      );
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.details.serverCode).toBe("artifact_not_found");
    expect(envelope.hint).toContain("cctl conversation compact");
  });
});

describe("cctl conversation compaction list", () => {
  it("prints one line per artifact and hints the get command", async () => {
    const host = makeHost(() =>
      jsonResponse([conversationArtifact, messageArtifact]),
    );
    const result = await runCcWithHost(
      ["conversation", "compaction", "list", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/context-artifacts",
    );
    expect(result.stdout).toContain("art-conv");
    expect(result.stdout).toContain("art-msg");
    expect(result.stdout).toContain("cctl conversation compaction get");
  });

  it("handles an empty list", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCcWithHost(
      ["conversation", "compaction", "list", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.artifacts).toEqual([]);
  });
});

describe("cctl conversation auto-resolve (cross-scope by id)", () => {
  // R2.4: a session agent reading a PROJECT conversation by id. The lookup
  // declares project scope and carries no sessionName, so the retry must select
  // the project route — inferring scope from a session name could not work here.
  it("retries on the project route when the lookup reports project scope", async () => {
    const host = makeHost((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/conversations/plc-1")
        return jsonResponse({
          scope: "project",
          projectName: "other-proj",
          conversationId: "plc-1",
        });
      if (pathname === "/api/projects/other-proj/conversations/plc-1/read")
        return jsonResponse(sampleTranscript);
      return jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      );
    });

    const result = await runCcWithHost(
      ["conversation", "read", "plc-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[2]?.url ?? "").pathname).toBe(
      "/api/projects/other-proj/conversations/plc-1/read",
    );
    for (const request of host.requests) {
      expect(request.url).not.toContain("__project__");
    }
    expect(result.stdout).toContain("[s0] fix the bug");
  });

  it("resolves the owning project/session by id after a scope miss, then reads that scope", async () => {
    const host = makeHost((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/conversations/conv-x")
        return jsonResponse({
          scope: "session",
          projectName: "other-proj",
          sessionName: "other-sess",
          conversationId: "conv-x",
        });
      if (
        pathname ===
        "/api/projects/other-proj/sessions/other-sess/conversations/conv-x/read"
      )
        return jsonResponse(sampleTranscript);
      // Caller-scope first attempt: the conversation is not in my-session.
      return jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      );
    });
    const result = await runCcWithHost(
      ["conversation", "read", "conv-x"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-x/read",
    );
    expect(new URL(host.requests[1]?.url ?? "").pathname).toBe(
      "/api/conversations/conv-x",
    );
    expect(new URL(host.requests[2]?.url ?? "").pathname).toBe(
      "/api/projects/other-proj/sessions/other-sess/conversations/conv-x/read",
    );
    expect(result.stdout).toContain("[s0] fix the bug");
  });

  it("auto-resolves scope for compaction get and fetches from the resolved scope", async () => {
    const host = makeHost((req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/conversations/conv-x")
        return jsonResponse({
          scope: "session",
          projectName: "other-proj",
          sessionName: "other-sess",
        });
      if (
        pathname ===
        "/api/projects/other-proj/sessions/other-sess/conversations/conv-x/context-artifacts"
      )
        return jsonResponse([conversationArtifact]);
      if (
        pathname ===
        "/api/projects/other-proj/sessions/other-sess/conversations/conv-x/context-artifacts/art-conv"
      )
        return jsonResponse({
          ...conversationArtifact,
          payload: { agentBrief: "resolved brief" },
        });
      return jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      );
    });
    const result = await runCcWithHost(
      ["conversation", "compaction", "get", "conv-x", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.artifact.payload.agentBrief).toBe(
      "resolved brief",
    );
  });

  it("does not auto-resolve when --session is explicit (a 404 stays exit 2)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-x", "--session", "explicit"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(1);
  });

  it("does not auto-resolve the caller's own conversation id", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "self-conv"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(1);
  });

  it("falls back to the original not-found when the id is unknown everywhere", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "ghost"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Conversation not found");
    // Caller-scope attempt + the lookup, both 404.
    expect(host.requests).toHaveLength(2);
  });
});

it("renders saved checkpoint coordinates and the omitted-boundary recovery command in text and JSON", async () => {
  const boundaries = {
    entries: [
      {
        operationId: "checkpoint-3",
        ordinal: 3,
        capturedThroughSeq: 2,
        afterMessageIndex: 0,
        nextSeq: 3,
      },
    ],
    totalInRange: 3,
    nextBefore: 3,
    indexCommand: "cctl conversation checkpoint list conv-1 --before 3",
  };
  for (const json of [false, true]) {
    const host = makeHost(() =>
      jsonResponse({ ...sampleTranscript, boundaries }),
    );
    const result = await runCcWithHost(
      ["conversation", "read", "conv-1", ...(json ? ["--json"] : [])],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("checkpoint-3");
    expect(result.stdout).toContain(boundaries.indexCommand);
    if (!json) {
      expect(result.stdout).toContain("raw seq 2");
      expect(result.stdout).toContain("2 checkpoint boundaries omitted");
    }
  }
});
