// @vitest-environment jsdom
import {
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  beforeEach,
  beforeAll,
} from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import ConnectedWorkflowBuilderPage, {
  resolveDefinitionClientSide,
} from "./ConnectedWorkflowBuilderPage";

const workflowMutationState = vi.hoisted(() => ({
  create: vi.fn(),
  createPending: false,
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/projects/test-project/workflows",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/Topbar", () => ({
  default: () => <div data-testid="topbar" />,
}));

const record = createWorkflowDefinitionRecord();
const workflowDefaults: WorkflowDefaults = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
  },
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    ],
  },
  scriptValidator: { enabled: false },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
};

const fullConfig: { config: GlobalConfig; raw: Record<string, unknown> } = {
  config: {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 3_600_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        timeoutMs: null,
      },
    },
    defaultAgentBackend: "claude",
    workflowDefaults,
  },
  raw: {},
};

vi.mock("@/lib/workflows/queries", () => ({
  useScopedWorkflowDefinitionsQuery: () => ({
    data: [
      {
        id: record.id,
        name: record.name,
        description: record.description,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ],
    isPending: false,
  }),
  useScopedWorkflowDefinitionQuery: () => ({
    data: {
      item: record,
      resolved: resolveWorkflowDefinition(fullConfig.config, record.definition),
    },
    isPending: false,
  }),
}));

vi.mock("@/lib/config/queries", () => ({
  useFullConfigQuery: () => ({
    data: fullConfig,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/lib/workflows/mutations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/mutations")>()),
  useScopedCreateWorkflowDefinitionMutation: () => ({
    mutateAsync: workflowMutationState.create,
    isPending: workflowMutationState.createPending,
  }),
  useScopedUpdateWorkflowDefinitionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useScopedDeleteWorkflowDefinitionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function resetStore() {
  _useGraphWorkflowBuilderStore.setState({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    validationErrors: [],
  });
}

function renderPage(dispatcher?: HotkeyDispatcher) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = (
    <QueryClientProvider client={qc}>
      <ConnectedWorkflowBuilderPage
        scope={{ kind: "project", projectName: "test-project" }}
      />
    </QueryClientProvider>
  );
  return render(
    dispatcher === undefined ? (
      page
    ) : (
      <HotkeyProvider dispatcher={dispatcher}>{page}</HotkeyProvider>
    ),
  );
}

describe("ConnectedWorkflowBuilderPage — workflow-settings chrome button", () => {
  beforeEach(() => {
    resetStore();
    workflowMutationState.createPending = false;
    workflowMutationState.create.mockReset();
    workflowMutationState.create.mockResolvedValue({
      item: { id: "created-workflow" },
    });
  });

  it("does not accept unused backend-default pass-through props", () => {
    expectTypeOf<
      React.ComponentProps<typeof ConnectedWorkflowBuilderPage>
    >().not.toHaveProperty("defaultImplementerConfig");
    expectTypeOf<
      React.ComponentProps<typeof ConnectedWorkflowBuilderPage>
    >().not.toHaveProperty("codexConfig");
  });

  it("renders the Workflow settings ghost button in the toolbar chrome", () => {
    const { container } = renderPage();
    const button = container.querySelector(
      "button[aria-label='Workflow settings']",
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toMatch(/Workflow settings/);
  });

  it("switches the inspector to the Workflow tab without clearing graph selection", () => {
    const { container, getByRole } = renderPage();

    // Select a graph node (simulates clicking a context)
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });

    // Context tab should now be active
    const contextTab = getByRole("tab", { name: /Context/i });
    expect(contextTab.getAttribute("aria-selected")).toBe("true");

    const gearBtn = container.querySelector(
      "button[aria-label='Workflow settings']",
    ) as HTMLButtonElement;
    fireEvent.click(gearBtn);

    const workflowTab = getByRole("tab", { name: /Workflow/i });
    expect(workflowTab.getAttribute("aria-selected")).toBe("true");

    // Selection is preserved
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
  });

  it("creates a workflow with C W when creation is available", async () => {
    const dispatcher = createHotkeyDispatcher();
    renderPage(dispatcher);

    await act(async () => {
      fireEvent.keyDown(document, { key: "c" });
      fireEvent.keyDown(document, { key: "w" });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(workflowMutationState.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Workflow 2",
        }),
      );
    });
  });

  it("marks new workflow unavailable while creation is pending", () => {
    workflowMutationState.createPending = true;
    const dispatcher = createHotkeyDispatcher();
    renderPage(dispatcher);

    expect(
      dispatcher
        .getCommands()
        .find((command) => command.definition.id === "newWorkflow")?.available,
    ).toBe(false);
  });
});

describe("resolveDefinitionClientSide", () => {
  it("produces the same output as the server resolveWorkflowDefinition", () => {
    const definition = createWorkflowDefinition();
    const clientResolved = resolveDefinitionClientSide(
      workflowDefaults,
      definition,
    );
    const serverResolved = resolveWorkflowDefinition(
      fullConfig.config,
      definition,
    );
    expect(clientResolved).toEqual(serverResolved);
  });
});
