// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "@/lib/workflow-graph/test-fixtures";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import type { GlobalConfig, WorkflowDefaults } from "@/types";
import ConnectedWorkflowBuilderPage, {
  resolveDefinitionClientSide,
} from "./ConnectedWorkflowBuilderPage";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

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
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false },
};

const fullConfig: { config: GlobalConfig; raw: Record<string, unknown> } = {
  config: {
    baseDir: "/projects",
    ignorePatterns: [],
    stateFilePath: "/tmp/state.json",
    claudeTimeoutMs: 3600000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
    workflowDefaults,
  },
  raw: {},
};

vi.mock("@/lib/queries", () => ({
  useWorkflowDefinitionsQuery: () => ({
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
  useWorkflowDefinitionQuery: () => ({
    data: {
      item: record,
      resolved: resolveWorkflowDefinition(fullConfig.config, record.definition),
    },
    isPending: false,
  }),
  useFullConfigQuery: () => ({
    data: fullConfig,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/lib/mutations", () => ({
  useCreateWorkflowDefinitionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUpdateWorkflowDefinitionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteWorkflowDefinitionMutation: () => ({
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
        projectName="test-project"
        defaultImplementerConfig={{
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        }}
      />
    </QueryClientProvider>,
  );
}

describe("ConnectedWorkflowBuilderPage — workflow-settings chrome button", () => {
  beforeEach(() => {
    resetStore();
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
