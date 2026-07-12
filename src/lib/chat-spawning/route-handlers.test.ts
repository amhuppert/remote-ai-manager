import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import {
  createSpawnRouteHandlers,
  type SpawnRouteDeps,
} from "./route-handlers";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { SpawnResult } from "./schemas";

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function rawRequest(raw: string): Request {
  return new Request("http://test/", { method: "POST", body: raw });
}

const PLC = conversationStateSchema.parse({
  id: "plc-1",
  scope: "project",
  transcriptPath: null,
  status: "new",
  promptCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  open: true,
});

const EMPTY_RESULT: SpawnResult = { created: [], failed: [] };

function makeDeps(overrides: Partial<SpawnRouteDeps> = {}): SpawnRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/repo"),
    getProjectDisplayName: vi.fn().mockReturnValue("repo"),
    getProjectConversation: vi.fn().mockResolvedValue(PLC),
    createFromProposal: vi.fn().mockResolvedValue(EMPTY_RESULT),
    ...overrides,
  };
}

const VALID_BODY = {
  sessions: [{ name: "alpha", agent: "claude", mode: "normal" }],
};

describe("createSpawnRouteHandlers POST", () => {
  it("returns 200 with the SpawnResult for a valid body", async () => {
    const result: SpawnResult = {
      created: [
        {
          name: "alpha",
          sessionName: "alpha",
          branchName: "csm/alpha",
          initialPromptQueued: false,
        },
      ],
      failed: [],
    };
    const deps = makeDeps({
      createFromProposal: vi.fn().mockResolvedValue(result),
    });
    const { POST } = createSpawnRouteHandlers(deps);

    const res = await POST(
      jsonRequest(VALID_BODY),
      ctx({ name: "repo", conversationId: "plc-1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    const call = (deps.createFromProposal as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.conversationId).toBe("plc-1");
    expect(call.projectPath).toBe("/repo");
  });

  it("returns 400 with issues for a malformed proposal", async () => {
    const deps = makeDeps();
    const { POST } = createSpawnRouteHandlers(deps);
    const res = await POST(
      jsonRequest({ sessions: [] }),
      ctx({ name: "repo", conversationId: "plc-1" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid spawn proposal");
    expect(deps.createFromProposal).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable JSON body", async () => {
    const deps = makeDeps();
    const { POST } = createSpawnRouteHandlers(deps);
    const res = await POST(
      rawRequest("{ not json"),
      ctx({ name: "repo", conversationId: "plc-1" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const deps = makeDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    const { POST } = createSpawnRouteHandlers(deps);
    const res = await POST(
      jsonRequest(VALID_BODY),
      ctx({ name: "nope", conversationId: "plc-1" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the project conversation does not exist", async () => {
    const deps = makeDeps({
      getProjectConversation: vi.fn().mockResolvedValue(null),
    });
    const { POST } = createSpawnRouteHandlers(deps);
    const res = await POST(
      jsonRequest(VALID_BODY),
      ctx({ name: "repo", conversationId: "ghost" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 for a partial batch (some sessions failed)", async () => {
    const partial: SpawnResult = {
      created: [
        {
          name: "alpha",
          sessionName: "alpha",
          branchName: "csm/alpha",
          initialPromptQueued: true,
        },
      ],
      failed: [{ name: "beta", error: "duplicate name" }],
    };
    const deps = makeDeps({
      createFromProposal: vi.fn().mockResolvedValue(partial),
    });
    const { POST } = createSpawnRouteHandlers(deps);
    const res = await POST(
      jsonRequest({
        sessions: [
          { name: "alpha", agent: "claude", mode: "normal" },
          { name: "beta", agent: "claude", mode: "normal" },
        ],
      }),
      ctx({ name: "repo", conversationId: "plc-1" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SpawnResult;
    expect(body.failed).toHaveLength(1);
  });
});
