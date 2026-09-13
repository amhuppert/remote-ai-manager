// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import {
  toPublicConversationState,
  type ConversationState,
  type PublicConversationState,
} from "@/lib/conversations/schemas";
import { createTestQueryClient } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";

import { useBackendModelSelection } from "./use-backend-model-selection";

const claudeCatalog = getStaticBackendModelCatalog("claude");
const codexCatalog = getStaticBackendModelCatalog("codex");
const cursorSnapshotCatalog = {
  ...codexCatalog,
  backend: "cursor",
  provenance: {
    source: "Cursor.models.list",
    generatedAt: "2026-08-25T18:55:11.561Z",
    sdkVersion: "1.0.28",
  },
} satisfies BackendModelCatalog;
const backendDefaults = {
  claude: defaultSelectionForModel(claudeCatalog, "opus"),
  codex: defaultSelectionForModel(codexCatalog, "gpt-5.4"),
  cursor: { modelId: "composer-2.5", parameters: {} },
} satisfies Record<string, BackendModelSelection>;

function makeConversation(
  overrides: Partial<ConversationState> = {},
): PublicConversationState {
  return toPublicConversationState({
    profileSnapshot: null,
    profileLockedAt: null,
    id: "c1",
    scope: "session",
    nameOrigin: "default",
    name: "chat",
    transcriptPath: null,
    status: "awaiting",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    owner: null,
    turnGeneration: 0,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  });
}

function projectEntry(
  backend: "claude" | "codex",
  defaultSelection = backendDefaults[backend],
) {
  const modelCatalog = backend === "claude" ? claudeCatalog : codexCatalog;
  return {
    backend,
    models: [],
    defaultModelId: defaultSelection.modelId,
    source: "catalog" as const,
    modelCatalog,
    defaultSelection,
    diagnostics: [],
  };
}

describe("useBackendModelSelection", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

  function serveEffectiveCatalogs(
    codexDefault: BackendModelSelection = backendDefaults.codex,
  ): void {
    api.json("GET", "/api/projects/proj/model-options", {
      backends: [projectEntry("claude"), projectEntry("codex", codexDefault)],
    });
  }

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: createTestQueryClient() },
      children,
    );
  }

  it("switches backends with the project-effective atomic default and catalog", async () => {
    const codexDefault = defaultSelectionForModel(
      codexCatalog,
      "gpt-5.6-terra",
    );
    serveEffectiveCatalogs(codexDefault);
    const { result } = renderHook(
      () =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation: makeConversation(),
          backendDefaults,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.modelCatalog).toEqual(claudeCatalog),
    );
    act(() => result.current.handleBackendChange("codex"));

    expect(result.current.modelSelection).toEqual(codexDefault);
    expect(result.current.modelCatalog).toEqual(codexCatalog);
    expect(result.current.modelCatalogs.codex).toEqual(codexCatalog);
    expect(result.current.modelSelectionValid).toBe(true);
  });

  it("starts a checkpoint fork with its chosen model, allows cross-backend edits, and locks on submission before prompt count advances", async () => {
    serveEffectiveCatalogs();
    const initial = { modelId: "gpt-5.4", parameters: { reasoning: "high" } };
    const origin = checkpointForkOriginFixture({
      initialSelection: { backend: "codex", modelSelection: initial },
    });
    const conversation = makeConversation({
      agentBackend: "codex",
      checkpointFork: origin,
    });
    const { result, rerender } = renderHook(
      ({ activeConversation }) =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation,
          backendDefaults,
        }),
      { wrapper, initialProps: { activeConversation: conversation } },
    );
    expect(result.current.modelSelection).toEqual(initial);
    expect(result.current.backendLocked).toBe(false);
    act(() => result.current.handleBackendChange("claude"));
    expect(result.current.selectedBackend).toBe("claude");
    rerender({
      activeConversation: makeConversation({
        agentBackend: "claude",
        promptCount: 0,
        checkpointFork: {
          ...origin,
          submission: { backend: "claude", at: "2026-09-12T12:00:00Z" },
        },
      }),
    });
    expect(result.current.backendLocked).toBe(true);
    act(() => result.current.handleBackendChange("codex"));
    expect(result.current.selectedBackend).toBe("claude");
  });

  it("preserves a stale whole selection instead of repairing it from defaults", async () => {
    serveEffectiveCatalogs();
    const staleSelection = {
      modelId: "removed-model",
      parameters: { reasoning: "obsolete", fast: "true" },
    };
    const { result } = renderHook(
      () =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation: makeConversation(),
          backendDefaults,
          lastUsedSelection: staleSelection,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.modelCatalog).not.toBeNull());
    expect(result.current.modelSelection).toEqual(staleSelection);
    expect(result.current.modelSelectionValid).toBe(false);
    expect(result.current.modelSelectionBlockedReason).toMatch(
      /removed-model.*not present/i,
    );
  });

  it("identifies the catalog snapshot used to reject a stale selection", async () => {
    const defaultSelection = defaultSelectionForModel(
      cursorSnapshotCatalog,
      cursorSnapshotCatalog.defaultModelId,
    );
    api.json("GET", "/api/projects/proj/model-options", {
      backends: [
        {
          backend: "cursor",
          models: [],
          defaultModelId: defaultSelection.modelId,
          source: "catalog",
          modelCatalog: cursorSnapshotCatalog,
          defaultSelection,
          diagnostics: [],
        },
      ],
    });
    const { result } = renderHook(
      () =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation: makeConversation({ agentBackend: "cursor" }),
          backendDefaults,
          lastUsedSelection: {
            modelId: "removed-model",
            parameters: { reasoning: "obsolete" },
          },
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.modelSelectionBlockedReason).toMatch(
        /removed-model.*not present/i,
      ),
    );
    expect(result.current.modelSelectionBlockedReason).toContain(
      "Cursor.models.list",
    );
    expect(result.current.modelSelectionBlockedReason).toContain(
      "2026-08-25T18:55:11.561Z",
    );
    expect(result.current.modelSelectionBlockedReason).toContain("SDK 1.0.28");
  });

  it("blocks controls when the effective catalog route returns a diagnostic", async () => {
    api.json("GET", "/api/projects/proj/model-options", {
      backends: [
        {
          backend: "claude",
          models: [],
          defaultModelId: null,
          source: "catalog",
          modelCatalog: null,
          defaultSelection: null,
          diagnostics: [
            {
              code: "model_catalog_unavailable",
              message: "The model catalog snapshot is unavailable.",
            },
          ],
        },
      ],
    });
    const { result } = renderHook(
      () =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation: makeConversation(),
          backendDefaults,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(result.current.modelSelectionBlockedReason).toMatch(
        /snapshot is unavailable/i,
      ),
    );
    expect(result.current.modelCatalog).toBeNull();
    expect(result.current.modelSelectionValid).toBe(false);
  });

  it("hydrates a locked conversation from its latest complete selection", async () => {
    serveEffectiveCatalogs();
    const runningSelection = defaultSelectionForModel(
      codexCatalog,
      "gpt-5.6-sol",
    );
    const initialProps: {
      activeConversation: PublicConversationState | undefined;
      lastUsedSelection: BackendModelSelection | undefined;
    } = {
      activeConversation: undefined,
      lastUsedSelection: undefined,
    };
    const { result, rerender } = renderHook(
      ({ activeConversation, lastUsedSelection }) =>
        useBackendModelSelection({
          projectName: "proj",
          conversationId: "c1",
          activeConversation,
          backendDefaults,
          lastUsedSelection,
        }),
      { initialProps, wrapper },
    );

    rerender({
      activeConversation: makeConversation({
        agentBackend: "codex",
        status: "running",
      }),
      lastUsedSelection: runningSelection,
    });

    expect(result.current.selectedBackend).toBe("codex");
    expect(result.current.modelSelection).toEqual(runningSelection);
    expect(result.current.backendLocked).toBe(true);
  });
});
