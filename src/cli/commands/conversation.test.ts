import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import {
  parseArgv,
  type CliEnv,
  type CliHost,
  type FetchInit,
} from "../shared";

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
  omissions: {
    thinkingOmitted: 0,
    toolResultBytesElided: 0,
    unitsOutsideWindow: 2,
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

describe("parseArgv boolean flags (regression)", () => {
  it("treats --outline, --include-thinking, and --force as valueless", () => {
    const parsed = parseArgv([
      "conversation",
      "read",
      "conv-1",
      "--outline",
      "--include-thinking",
      "--force",
      "trailing",
    ]);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.positionals).toEqual([
      "conversation",
      "read",
      "conv-1",
      "trailing",
    ]);
    expect(parsed.values["outline"]).toBe("true");
    expect(parsed.values["include-thinking"]).toBe("true");
    expect(parsed.values["force"]).toBe("true");
  });

  it("does not swallow a following value flag after a boolean", () => {
    const parsed = parseArgv([
      "conversation",
      "read",
      "--outline",
      "--search",
      "foo",
    ]);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    expect(parsed.values["outline"]).toBe("true");
    expect(parsed.values["search"]).toBe("foo");
  });
});

describe("cctl conversation read", () => {
  it("GETs the session-scoped read endpoint with mapped query params", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCli(
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
    const result = await runCli(["conversation", "read"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/self-conv/read",
    );
  });

  it("exits 2 without any conversation id and makes no request", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const env: CliEnv = { ...baseEnv };
    delete env["CC_CONVERSATION_ID"];
    const result = await runCli(["conversation", "read"], env, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_CONVERSATION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("uses the project-scoped path when --project is given without --session", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCli(
      ["conversation", "read", "conv-9", "--project", "other"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/other/conversations/conv-9/read",
    );
  });

  it("sends boolean flags as query params and hints escalation after --outline", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCli(
      ["conversation", "read", "conv-1", "--outline", "--include-thinking"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("outline")).toBe("true");
    expect(url.searchParams.get("includeThinking")).toBe("true");
    expect(result.stdout).toContain(
      "hint: narrow with --message-range or fetch the compaction: cctl conversation compaction get conv-1",
    );
  });

  it("prints raw text for --format markdown", async () => {
    const host = makeHost(
      () =>
        new Response("# transcript\n\nbody\n", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );
    const result = await runCli(
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
    const result = await runCli(
      ["conversation", "read", "conv-1", "--format", "markdown", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.markdown).toBe("# transcript\n");
  });

  it("carries the full response body in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCli(
      ["conversation", "read", "conv-1", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.transcript).toEqual(sampleTranscript);
  });

  it("reports truncation instead of 'no matching units' when an oversize unit was elided whole", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleTranscript, units: [], truncated: true }),
    );
    const result = await runCli(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("no matching transcript units");
    expect(result.stdout).toContain("truncated");
    expect(result.stdout).toContain("--max-bytes");
  });

  it("still reports 'no matching transcript units' for an empty, untruncated window", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...sampleTranscript, units: [], truncated: false }),
    );
    const result = await runCli(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no matching transcript units");
  });

  it("exits 2 on an unknown conversation (404 conversation_not_found)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCli(
      ["conversation", "read", "nope"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Conversation not found");
  });

  it("exits 2 with per-issue lines on invalid read options (400)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Invalid read options",
          code: "invalid_read_options",
          issues: [
            {
              path: "search",
              message: "search must be a valid regular expression",
            },
          ],
        },
        400,
      ),
    );
    const result = await runCli(
      ["conversation", "read", "conv-1", "--search", "["],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "search must be a valid regular expression",
    );
  });

  it("exits 2 when given more than one positional", async () => {
    const host = makeHost(() => jsonResponse(sampleTranscript));
    const result = await runCli(
      ["conversation", "read", "a", "b"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl conversation compact", () => {
  it("POSTs create_or_refresh and reports pending with a hint", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifactId: "art-1", status: "pending" }, 202),
    );
    const result = await runCli(
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
    expect(result.stdout).toContain(
      "hint: check status with: cctl conversation compaction get conv-1",
    );
  });

  it("targets a message compaction with --message and passes --force", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifactId: "art-2", status: "pending" }, 202),
    );
    const result = await runCli(
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

  it("exits 2 on a non-integer --message and makes no request", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["conversation", "compact", "conv-1", "--message", "abc"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("reports an already-fresh artifact without waiting", async () => {
    const host = makeHost(() =>
      jsonResponse({ artifact: conversationArtifact, hint: "already fresh" }),
    );
    const result = await runCli(
      ["conversation", "compact", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.artifact.id).toBe("art-conv");
    expect(envelope.hint).toBe("already fresh");
  });

  it("polls the artifact to completion under --wait", async () => {
    const host = makeHost((_req, index) => {
      if (index === 0)
        return jsonResponse({ artifactId: "art-conv", status: "pending" }, 202);
      if (index === 1)
        return jsonResponse({ ...conversationArtifact, status: "pending" });
      return jsonResponse(conversationArtifact);
    });
    const result = await runCli(
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
    expect(envelope.ok).toBe(true);
    expect(envelope.artifact.status).toBe("complete");
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
    const result = await runCli(
      ["conversation", "compact", "conv-1", "--wait"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("model returned invalid envelope");
  });

  it("exits 2 on an unknown conversation (404 conversation_not_found)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCli(
      ["conversation", "compact", "nope"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
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
    const result = await runCli(
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
    expect(envelope.ok).toBe(true);
    expect(envelope.artifact.payload.agentBrief).toBe("the brief");
    expect(envelope.hint).toBeUndefined();
  });

  it("selects the message artifact for --message N", async () => {
    const host = makeHost((req) => {
      const pathname = new URL(req.url).pathname;
      if (pathname.endsWith("/context-artifacts"))
        return jsonResponse([conversationArtifact, messageArtifact]);
      return jsonResponse({ ...messageArtifact, payload: {} });
    });
    const result = await runCli(
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
    const result = await runCli(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "hint: refresh with: cctl conversation compact conv-1",
    );
  });

  it("exits 1 with a create hint when no artifact exists", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "hint: create with: cctl conversation compact conv-1",
    );
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
    const result = await runCli(
      ["conversation", "compaction", "get", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("create with: cctl conversation compact");
  });

  it("exits 2 on an unknown conversation (404 conversation_not_found)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Conversation not found", code: "conversation_not_found" },
        404,
      ),
    );
    const result = await runCli(
      ["conversation", "compaction", "get", "nope"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("cctl conversation compaction list", () => {
  it("prints one line per artifact and hints the get command", async () => {
    const host = makeHost(() =>
      jsonResponse([conversationArtifact, messageArtifact]),
    );
    const result = await runCli(
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
    expect(result.stdout).toContain(
      "hint: fetch the full envelope with: cctl conversation compaction get conv-1",
    );
  });

  it("handles an empty list", async () => {
    const host = makeHost(() => jsonResponse([]));
    const result = await runCli(
      ["conversation", "compaction", "list", "conv-1", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.artifacts).toEqual([]);
  });
});

describe("cctl conversation (dispatch)", () => {
  it("exits 2 without a subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["conversation"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["conversation", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when compaction lacks a verb", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["conversation", "compaction"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });

  it("exits 3 when the server is unreachable", async () => {
    const host: CliHost = {
      async fetch() {
        throw new Error("ECONNREFUSED");
      },
      async readTextFile() {
        return null;
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
    const result = await runCli(
      ["conversation", "read", "conv-1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(3);
  });
});
