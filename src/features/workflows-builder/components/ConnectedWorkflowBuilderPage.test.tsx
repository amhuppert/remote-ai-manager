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
    backend: "claude",
    model: "opus",
    reasoningEffort: "medium",
  },
  contextValidator: {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
  },
  scriptValidator: { enabled: false },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false },
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
    mutateAsync: vi.fn(),
    isPending: false,
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

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectedWorkflowBuilderPage
        scope={{ kind: "project", projectName: "test-project" }}
      />
    </QueryClientProvider>,
  );
}

describe("ConnectedWorkflowBuilderPage — workflow-settings chrome button", () => {
  beforeEach(() => {
    resetStore();
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
