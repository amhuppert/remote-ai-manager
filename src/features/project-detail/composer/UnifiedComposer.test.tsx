// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UnifiedComposer, {
  resolveProjectComposerSubmit,
  type UnifiedComposerProps,
} from "./UnifiedComposer";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { loadGeneratedCursorModelCatalog } from "@/lib/agent-backends/cursor/model-catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import type { BackendModelCatalog } from "@/lib/agent-backends/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "true" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

function projectModelOptions(defaults: BackendSelectionDefaultsById) {
  const catalogs: Record<"claude" | "codex" | "cursor", BackendModelCatalog> = {
    claude: getStaticBackendModelCatalog("claude"),
    codex: getStaticBackendModelCatalog("codex", defaults.codex),
    cursor: loadGeneratedCursorModelCatalog(),
  };
  return (["claude", "codex", "cursor"] as const).map((backend) => {
    const catalog = catalogs[backend];
    return {
      backend,
      models: catalog.models.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description ?? model.label,
        effortLevels: [],
      })),
      defaultModelId: defaults[backend].modelId,
      source: "catalog" as const,
      modelCatalog: catalog,
      defaultSelection: defaults[backend],
      diagnostics: [],
    };
  });
}

function makeConversation(
  o: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    id: "plc-1",
    scope: "project",
    name: "chat",
    status: "new",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
    ...o,
  });
}

const runningSession: SessionListItem = {
  sessionName: "s1",
  worktreePath: "/tmp/s1",
  branchName: "csm/s1",
  targetBranch: "main",
  parentSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z",
  archived: false,
  finished: false,
  source: "cc",
  creationMode: "normal",
  tddEnabled: true,
  derivedStatus: "running",
  promptCount: 1,
  derivedLastActivityAt: "2026-01-01T00:00:00Z",
  collabContribution: null,
  hasActiveGraphWorkflow: false,
};

function renderComposer(overrides: Partial<UnifiedComposerProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const props: UnifiedComposerProps = {
    projectName: "proj",
    activeConversationId: "plc-1",
    activeConversation: makeConversation(),
    agentBackend: "claude",
    backendDefaults: BACKEND_DEFAULTS,
    onAgentChange: vi.fn(),
    tokens: [],
    onTokensChange: vi.fn(),
    sessions: [runningSession],
    archivedCount: 0,
    onSendPrompt: vi.fn(async () => "accepted" as const),
    onRunCommand: vi.fn(),
    busy: false,
    ...overrides,
  };
  client.setQueryData(
    backendCatalogKeys.projectModelOptions(props.projectName),
    projectModelOptions(props.backendDefaults),
  );
  const rendered = render(
    <QueryClientProvider client={client}>
      <UnifiedComposer {...props} />
    </QueryClientProvider>,
  );
  return {
    props,
    client,
    rerender(nextOverrides: Partial<UnifiedComposerProps>) {
      rendered.rerender(
        <QueryClientProvider client={client}>
          <UnifiedComposer {...props} {...nextOverrides} />
        </QueryClientProvider>,
      );
    },
  };
}

beforeEach(() => {
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  // useVoiceRecorder pings /api/voice/health on mount.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ available: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UnifiedComposer shared prompt input", () => {
  it("renders the session PromptComposer chrome instead of project-specific input controls", async () => {
    renderComposer();
    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(document.querySelector(".prompt-toolbar")).not.toBeNull();
    expect(document.querySelector(".send-btn")?.textContent).toBe("▶");
    expect(screen.queryByLabelText("Project composer")).toBeNull();
    // Tiptap attaches the EditorView in an async effect after render, so the
    // .ProseMirror node appears a tick later; allow extra time for that mount
    // to survive CPU contention when the full suite runs in parallel.
    await waitFor(
      () =>
        expect(
          document.querySelector(".prompt-editor__content .ProseMirror"),
        ).not.toBeNull(),
      { timeout: 5000 },
    );
    expect(
      document.querySelector('textarea[placeholder^="Message the"]'),
    ).toBeNull();
  });

  it("registers no query key carrying the store sentinel", async () => {
    // The composer hands the session-shaped `PromptComposer` subtree the store
    // sentinel as `sessionName`. A React Query key is a public identity surface
    // (R1.3) and hooks build their keys eagerly — a disabled query still
    // registers one — so no descendant may key by that value.
    const { client } = renderComposer();
    await waitFor(
      () =>
        expect(
          document.querySelector(".prompt-editor__content .ProseMirror"),
        ).not.toBeNull(),
      { timeout: 5000 },
    );

    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.queryKey));
    expect(
      keys.filter((key) => key.includes(PROJECT_CONVERSATION_SESSION_SENTINEL)),
    ).toEqual([]);
  });

  it("hydrates a canonical conversation draft and reports the cleared document after send", async () => {
    const onSendPrompt = vi.fn(async () => "accepted" as const);
    const onDocumentChange = vi.fn();
    const initialDocument = {
      prompt: "Continue from this draft",
      images: [
        {
          attachmentId: "draft-image",
          mediaType: "image/png" as const,
          base64Data: "cGF5bG9hZA==",
        },
      ],
    };
    renderComposer({
      initialDocument,
      onDocumentChange,
      onSendPrompt,
    });

    await waitFor(() =>
      expect(
        document.querySelector(".prompt-editor__content .ProseMirror"),
      ).toHaveTextContent("Continue from this draft"),
    );
    fireEvent.click(screen.getByTestId("prompt-send"));

    expect(onSendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Continue from this draft",
        images: initialDocument.images,
      }),
    );
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      prompt: "",
      images: [],
    });
  });
});

describe("UnifiedComposer backend lock", () => {
  it("allows selecting the backend before the conversation is initialized", () => {
    const { props } = renderComposer({
      activeConversation: makeConversation({ promptCount: 0 }),
    });
    const codexBtn = document.querySelector('[data-backend="codex"]');
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn!);
    expect(props.onAgentChange).toHaveBeenCalledWith("codex");
  });

  it("presents the backend as fixed once the conversation is initialized", () => {
    renderComposer({
      activeConversation: makeConversation({ promptCount: 3 }),
    });
    expect(document.querySelector(".backend-toggle-badge")).not.toBeNull();
    expect(document.querySelector('[data-backend="codex"]')).toBeNull();
  });
});

describe("UnifiedComposer model settings", () => {
  it("initializes and switches complete selections from each configured backend profile", async () => {
    const rendered = renderComposer({
      activeConversation: makeConversation({ promptCount: 0 }),
    });

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "Sonnet",
    );
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(
      "Medium",
    );

    fireEvent.click(document.querySelector('[data-backend="codex"]')!);
    rendered.rerender({ agentBackend: "codex" });

    expect(await screen.findByTestId("model-selector-label")).toHaveTextContent(
      "GPT-5.6 Sol",
    );
    expect(
      screen.getByRole("combobox", { name: "Reasoning" }),
    ).toHaveTextContent("Ultra");
  });

  // The canonical selection flow for a Cursor conversation: pick the backend
  // from the shared toggle, see the effective backend and model, and see no
  // credential anywhere — the key is a server environment variable that no
  // client surface is given (spec R12.1).
  it("selects cursor from the canonical toggle and shows its effective backend and model", async () => {
    const rendered = renderComposer({
      activeConversation: makeConversation({ promptCount: 0 }),
    });

    const cursorOption = document.querySelector('[data-backend="cursor"]');
    if (!(cursorOption instanceof HTMLButtonElement)) {
      throw new Error("no cursor option in the backend toggle");
    }
    expect(cursorOption.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(cursorOption);
    rendered.rerender({ agentBackend: "cursor" });

    expect(await screen.findByTestId("model-selector-label")).toHaveTextContent(
      "Composer 2.5",
    );
    const activeToggle = document.querySelector(
      'button[data-backend="cursor"][data-active="true"]',
    );
    expect(activeToggle?.textContent).toBe("Cursor");
    expect(screen.getByRole("button", { name: "Model options" })).toBeEnabled();
    expect(document.body.innerHTML).not.toMatch(/api[-_ ]?key/i);
  });

  it("initializes controls from the active conversation's last complete selection", async () => {
    renderComposer({
      activeConversation: makeConversation({ promptCount: 2 }),
      lastUsedModelSelection: {
        modelId: "sonnet",
        parameters: { effort: "low" },
      },
    });

    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "Sonnet",
    );
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(
      "Low",
    );
  });

  it("shows and submits the configured custom Codex model unchanged", () => {
    const customModel = "custom-codex-model";
    const customSelection = {
      modelId: customModel,
      parameters: { reasoning: "ultra", fast: "true" },
    };
    renderComposer({
      agentBackend: "codex",
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 0,
      }),
      backendDefaults: {
        ...BACKEND_DEFAULTS,
        codex: customSelection,
      },
    });

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      customModel,
    );
    expect(
      resolveProjectComposerSubmit({
        draft: "run it",
        pendingImages: [],
        tokens: [],
        backend: "codex",
        modelSelection: customSelection,
      }),
    ).toMatchObject({
      kind: "send",
      input: { backend: "codex", modelSelection: customSelection },
    });
  });

  it("preserves an invalid higher-precedence selection and blocks submission", () => {
    renderComposer({
      agentBackend: "codex",
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 2,
      }),
      lastUsedModelSelection: {
        modelId: "opus",
        parameters: { effort: "ultra" },
      },
    });

    expect(screen.getByTestId("model-selector-label")).toHaveTextContent(
      "opus",
    );
    expect(screen.getByTestId("prompt-send")).toBeDisabled();
  });
});

describe("resolveProjectComposerSubmit", () => {
  it("routes prose as a send envelope", () => {
    const result = resolveProjectComposerSubmit({
      draft: " fix the bug ",
      pendingImages: [],
      tokens: [],
      backend: "claude",
      modelSelection: {
        modelId: "claude-sonnet-4-5-20250929",
        parameters: { effort: "high" },
      },
    });
    expect(result).toEqual({
      kind: "send",
      input: {
        text: "fix the bug",
        images: [],
        backend: "claude",
        modelSelection: {
          modelId: "claude-sonnet-4-5-20250929",
          parameters: { effort: "high" },
        },
      },
    });
  });

  it("routes slash commands without sending a prompt", () => {
    expect(
      resolveProjectComposerSubmit({
        draft: "/capabilities",
        pendingImages: [],
        tokens: [],
        backend: "claude",
        modelSelection: {
          modelId: "claude-sonnet-4-5-20250929",
          parameters: { effort: "high" },
        },
      }),
    ).toEqual({ kind: "command", id: "capabilities" });
    expect(
      resolveProjectComposerSubmit({
        draft: "/",
        pendingImages: [],
        tokens: [],
        backend: "claude",
        modelSelection: {
          modelId: "claude-sonnet-4-5-20250929",
          parameters: { effort: "high" },
        },
      }),
    ).toEqual({ kind: "command", id: "new" });
  });

  it("routes key:value filters into shared tokens", () => {
    const result = resolveProjectComposerSubmit({
      draft: "is:running",
      pendingImages: [],
      tokens: [],
      backend: "claude",
      modelSelection: {
        modelId: "claude-sonnet-4-5-20250929",
        parameters: { effort: "high" },
      },
    });
    expect(result.kind).toBe("tokens");
    if (result.kind !== "tokens") return;
    expect(result.tokens).toEqual([
      { cat: "status", key: "is", value: "running" },
    ]);
  });
});
