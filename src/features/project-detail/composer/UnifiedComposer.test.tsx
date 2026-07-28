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
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: {
    modelId: "gpt-5.6-sol",
    effort: "ultra",
    codexFastMode: true,
  },
};

function makeConversation(
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "plc-1",
    scope: "project",
    name: "chat",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...o,
  };
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
  it("initializes and switches controls from each configured backend profile", async () => {
    const rendered = renderComposer({
      activeConversation: makeConversation({ promptCount: 0 }),
    });

    expect(screen.getByTitle(/Model: Sonnet/)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /Effort: Medium/i }),
    ).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-backend="codex"]')!);
    rendered.rerender({ agentBackend: "codex" });

    expect(await screen.findByTitle(/Model: GPT-5.6 Sol/)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: /Effort: Ultra/i }),
    ).toBeInTheDocument();
  });

  it("initializes controls from the active conversation's last sent model and effort", async () => {
    renderComposer({
      activeConversation: makeConversation({ promptCount: 2 }),
      lastUsedModelId: "sonnet",
      lastUsedEffort: "medium",
    });

    await waitFor(() =>
      expect(document.querySelector(".prompt-input-area")).not.toBeNull(),
    );
    expect(screen.getByTitle(/Model: Sonnet/)).toBeInTheDocument();
    // The effort trigger is now a Radix Select (role="combobox"), named by its
    // aria-label; the model trigger is matched above by its descriptive title.
    expect(
      screen.getByRole("combobox", { name: /Effort: Medium/i }),
    ).toBeInTheDocument();
  });

  it("shows and submits the configured custom Codex model unchanged", () => {
    const customModel = "custom-codex-model";
    renderComposer({
      agentBackend: "codex",
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 0,
      }),
      backendDefaults: {
        claude: { modelId: "sonnet", effort: "medium" },
        codex: { modelId: customModel, effort: "ultra" },
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
        modelId: customModel,
        effort: "ultra",
        effortSupported: true,
      }),
    ).toMatchObject({
      kind: "send",
      input: { backend: "codex", modelId: customModel, effort: "ultra" },
    });
  });
});

describe("UnifiedComposer Codex speed", () => {
  it("initializes a new Codex conversation from the global default", () => {
    renderComposer({
      agentBackend: "codex",
      activeConversationId: null,
      activeConversation: undefined,
    });

    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("restores the active conversation's last sent speed over the global default", () => {
    renderComposer({
      agentBackend: "codex",
      activeConversation: makeConversation({
        agentBackend: "codex",
        promptCount: 2,
      }),
      lastUsedCodexFastMode: false,
    });

    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("includes the selected speed on Codex sends and omits it from Claude sends", () => {
    const common = {
      draft: "ship it",
      pendingImages: [],
      tokens: [],
      modelId: "model",
      effort: "high" as const,
      effortSupported: true,
      codexFastMode: true,
    };

    expect(
      resolveProjectComposerSubmit({ ...common, backend: "codex" }),
    ).toMatchObject({
      kind: "send",
      input: { backend: "codex", codexFastMode: true },
    });
    expect(
      resolveProjectComposerSubmit({ ...common, backend: "claude" }),
    ).toEqual({
      kind: "send",
      input: {
        text: "ship it",
        images: [],
        backend: "claude",
        modelId: "model",
        effort: "high",
      },
    });
  });
});

describe("resolveProjectComposerSubmit", () => {
  it("routes prose as a send envelope", () => {
    const result = resolveProjectComposerSubmit({
      draft: " fix the bug ",
      pendingImages: [],
      tokens: [],
      backend: "claude",
      modelId: "claude-sonnet-4-5-20250929",
      effort: "high",
      effortSupported: true,
    });
    expect(result).toEqual({
      kind: "send",
      input: {
        text: "fix the bug",
        images: [],
        backend: "claude",
        modelId: "claude-sonnet-4-5-20250929",
        effort: "high",
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
        modelId: "claude-sonnet-4-5-20250929",
        effort: "high",
        effortSupported: true,
      }),
    ).toEqual({ kind: "command", id: "capabilities" });
    expect(
      resolveProjectComposerSubmit({
        draft: "/",
        pendingImages: [],
        tokens: [],
        backend: "claude",
        modelId: "claude-sonnet-4-5-20250929",
        effort: "high",
        effortSupported: true,
      }),
    ).toEqual({ kind: "command", id: "new" });
  });

  it("routes key:value filters into shared tokens", () => {
    const result = resolveProjectComposerSubmit({
      draft: "is:running",
      pendingImages: [],
      tokens: [],
      backend: "claude",
      modelId: "claude-sonnet-4-5-20250929",
      effort: "high",
      effortSupported: true,
    });
    expect(result.kind).toBe("tokens");
    if (result.kind !== "tokens") return;
    expect(result.tokens).toEqual([
      { cat: "status", key: "is", value: "running" },
    ]);
  });
});
