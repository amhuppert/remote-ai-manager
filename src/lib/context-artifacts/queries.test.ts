// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CONTEXT_ARTIFACT_SCHEMA_VERSION } from "./schemas";
import type { CompactionEnvelope } from "./schemas";
import type { ContextArtifactTarget } from "./query-keys";
import {
  contextArtifactsBaseUrl,
  useContextArtifact,
  useContextArtifacts,
} from "./queries";

const sessionTarget: ContextArtifactTarget = {
  scope: "session",
  projectName: "proj one",
  sessionName: "sess",
  conversationId: "conv-1",
};

const projectTarget: ContextArtifactTarget = {
  scope: "project",
  projectName: "proj one",
  conversationId: "conv-1",
};

const envelope: CompactionEnvelope = {
  schemaVersion: 1,
  kind: "conversation_compaction",
  source: {
    projectName: "proj one",
    sessionName: "sess",
    conversationId: "conv-1",
    coveredStartSeq: 0,
    coveredEndSeq: 42,
    messageCount: 10,
    sourceHash: "hash",
  },
  agentBrief: "Implemented the widget.",
  currentState: {
    status: "green",
    latestUserGoal: "Ship the widget",
    nextBestActions: ["Run the suite"],
  },
  decisions: [],
  files: [],
  commands: [],
  openQuestions: [],
  blockers: [],
  omissions: { reasoningOmitted: true, largeToolOutputsElided: 2 },
  extras: {},
};

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a-1",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/p/proj one",
    sessionName: "sess",
    conversationId: "conv-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 42,
    sourceHash: "hash",
    status: "complete",
    error: null,
    modelProvider: "claude",
    model: "claude-sonnet-4-5",
    effort: "medium",
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "v1",
    normalizerVersion: "v1",
    createdBy: "user",
    createdByConversationId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("contextArtifactsBaseUrl", () => {
  it("builds the encoded session-scope route", () => {
    expect(contextArtifactsBaseUrl(sessionTarget)).toBe(
      "/api/projects/proj%20one/sessions/sess/conversations/conv-1/context-artifacts",
    );
  });

  it("builds the project-scope route without a sessions segment", () => {
    expect(contextArtifactsBaseUrl(projectTarget)).toBe(
      "/api/projects/proj%20one/conversations/conv-1/context-artifacts",
    );
  });
});

describe("useContextArtifacts", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches and parses the session-scope list including freshness flags", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([serverRow({ stale: true, staleBehindMessages: 4 })]),
    );

    const { result } = renderHook(() => useContextArtifacts(sessionTarget), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj%20one/sessions/sess/conversations/conv-1/context-artifacts",
    );
    expect(result.current.data?.[0]?.id).toBe("a-1");
    expect(result.current.data?.[0]?.stale).toBe(true);
    expect(result.current.data?.[0]?.staleBehindMessages).toBe(4);
  });

  it("fetches the project-scope list from the project route", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse([serverRow({ scope: "project", sessionName: null })]),
    );

    const { result } = renderHook(() => useContextArtifacts(projectTarget), {
      wrapper: wrapperFor(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj%20one/conversations/conv-1/context-artifacts",
    );
    expect(result.current.data?.[0]?.scope).toBe("project");
  });

  it("does not fetch when disabled", async () => {
    const { result } = renderHook(
      () => useContextArtifacts(sessionTarget, { enabled: false }),
      { wrapper: wrapperFor(makeClient()) },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("useContextArtifact", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches one artifact including the payload envelope", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(serverRow({ payload: envelope })));

    const { result } = renderHook(
      () => useContextArtifact(sessionTarget, "a-1"),
      { wrapper: wrapperFor(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj%20one/sessions/sess/conversations/conv-1/context-artifacts/a-1",
    );
    expect(result.current.data?.payload?.agentBrief).toBe(
      "Implemented the widget.",
    );
    expect(result.current.data?.outdated).toBe(false);
  });
});
