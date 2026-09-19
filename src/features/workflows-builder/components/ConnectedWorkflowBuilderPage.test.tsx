// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
  beforeEach,
  beforeAll,
} from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
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
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";
import ConnectedWorkflowBuilderPage, {
  resolveDefinitionClientSide,
} from "./ConnectedWorkflowBuilderPage";

const workflowMutationState = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  createPending: false,
}));
const workflowQueryState = vi.hoisted(() => ({
  definitions: null as null | Array<Record<string, unknown>>,
  detail: null as null | { item: Record<string, unknown>; resolved: unknown },
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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "medium" },
      },
    },
  },
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        authority: "blocking",
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      },
    ],
  },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20 },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "medium" },
      },
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
  agentValidation: {
    implementer: { mode: "all", except: [] },
    contextValidator: { mode: "only", commands: [] },
  },
  laneMergeValidation: {
    strategy: "final-only",
    commands: { mode: "project" },
  },
  memory: {
    implementer: { read: "ambient", contribute: "on" },
    validator: { read: "off", contribute: "off" },
  },
};

const fullConfig: { config: GlobalConfig; raw: Record<string, unknown> } = {
  config: {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        timeoutMs: 3_600_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: null,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
    defaultAgentBackend: "claude",
    workflowDefaults,
  },
  raw: {},
};

function managedDetail(
  lifecycle: NativeSddWorkflowManagementDetail["lifecycle"],
): NativeSddWorkflowManagementDetail {
  return {
    kind: "native_sdd_delivery",
    specId: "spec-1",
    specSlug: "checkout",
    specName: "Checkout",
    attemptId: "attempt-1",
    pinnedRevisionId: "revision-8",
    pinnedRevisionNumber: 8,
    lifecycle,
    editable: lifecycle === "draft",
    isCurrentDefinition: true,
    specHref: "/specs/test-project/checkout",
    builderHref: `/projects/test-project/workflows?definition=${record.id}`,
    executionHref: null,
    bindingRevision: 2,
    deltaBasisExecutionId: null,
    binding: { dispositions: [] },
    dispositionCounts: {},
    unresolvedItems: [],
    criterionRows: [],
    claims: [],
    comments: [],
    nextAct: lifecycle === "draft" ? "propose" : "sign_off",
    currentCandidate: null,
    currentCandidateHash: null,
    currentApproval: null,
    approvedBaseline: null,
    changes: {
      workflowSettings: false,
      contexts: false,
      tasks: false,
      edges: false,
      layout: false,
      dispositions: false,
      claims: false,
    },
    capabilities: {
      canPropose: lifecycle === "draft",
      canSignOff: lifecycle === "in_review",
      canReopen: lifecycle === "in_review",
      canAbandon: true,
      canLaunch: false,
      refusals: {},
    },
  };
}

function proposedDeliveryPlanResponse(): Record<string, unknown> {
  return {
    attempt: {
      id: "attempt-1",
      specSlug: "checkout",
      status: "proposed",
      draftRevision: 2,
      pinnedRevisionId: "revision-8",
      deltaBasisExecutionId: null,
      proposedSnapshotId: "snapshot-1",
      candidateId: record.id,
      candidateHash: "sha256:candidate",
      launchedExecutionId: null,
      workflowDefinitionId: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    approval: null,
    prelaunch: null,
    document: {
      schemaVersion: 3,
      binding: { dispositions: [] },
    },
    workflowDefinition: {
      id: record.id,
      revision: record.revision,
      definitionHash: "sha256:definition",
      builderHref: `/projects/test-project/workflows?definition=${record.id}`,
    },
    health: { total: 0, blocking: 0, counts: [], findings: [] },
    dispositionCounts: [],
    unresolved: [],
    snapshots: [],
    nextAct: {
      actor: "human",
      command: "Review the managed definition",
      reason: "The delivery plan is ready for review.",
    },
    previousHealth: null,
    invalidatedApproval: null,
    executionStartAdmission: null,
  };
}

vi.mock("@/lib/workflows/queries", () => ({
  // Reached through the sidebar's approval peek; no gate stands in this page's
  // fixtures, so the query is never enabled and a quiet stub is sufficient.
  useGraphWorkflowApprovalSnapshotQuery: () => ({
    data: undefined,
    error: null,
  }),
  useScopedWorkflowDefinitionsQuery: () => ({
    data: workflowQueryState.definitions ?? [
      {
        id: record.id,
        name: record.name,
        description: record.description,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      // A second, UNLOADED definition: the builder holds one draft, so this row
      // is the one that proves list metadata does not depend on being selected.
      {
        id: "workflow-unloaded",
        name: "Unloaded Workflow",
        description: null,
        revision: 7,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    ],
    isPending: false,
  }),
  // Echoes back a count per id it was asked about, so a row missing from the
  // rendered list can only be the page failing to ask for it.
  useScopedWorkflowDefinitionContextCounts: (
    _scope: unknown,
    ids: readonly string[],
  ) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        id === record.id ? record.definition.executionContexts.length : 5,
      ]),
    ),
  useScopedWorkflowDefinitionQuery: () => ({
    data: workflowQueryState.detail ?? {
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
    mutateAsync: workflowMutationState.update,
    isPending: false,
  }),
  useScopedDeleteWorkflowDefinitionMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// The §12 ladder is width-driven, so the stub answers `(max-width: Npx)` from a
// viewport a test can set rather than always reporting desktop — the mobile
// panels only exist below 768px.
let viewportWidth = 1440;

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
      return {
        matches:
          maxWidth === undefined || maxWidth === null
            ? false
            : viewportWidth <= Number(maxWidth[1]),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
});

beforeEach(() => {
  viewportWidth = 1440;
  workflowQueryState.definitions = null;
  workflowQueryState.detail = null;
  workflowMutationState.update.mockReset();
  workflowMutationState.update.mockResolvedValue({});
});

function resetStore() {
  _useGraphWorkflowBuilderStore.setState({
    persistedDraft: null,
    draftDefinition: null,
    draftLayout: null,
    selectedContextId: null,
    selectedTaskId: null,
    dirty: false,
    refusedEdits: [],
    pendingOutputSchemaText: {},
    highlightedContextIds: [],
  });
}

function renderPage(
  dispatcher?: HotkeyDispatcher,
  scope: React.ComponentProps<typeof ConnectedWorkflowBuilderPage>["scope"] = {
    kind: "project",
    projectName: "test-project",
  },
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = (
    <QueryClientProvider client={qc}>
      <ConnectedWorkflowBuilderPage scope={scope} />
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
    const { getByRole } = renderPage();
    const button = getByRole("button", { name: "Workflow settings" });
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("switches the rail to Workflow scope without clearing graph selection", () => {
    const { getByRole } = renderPage();

    // Select a graph node (simulates clicking a context)
    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });

    // Selecting a context switches the rail to Context scope (README §5).
    expect(getByRole("radio", { name: "Context" })).toBeChecked();

    fireEvent.click(getByRole("button", { name: "Workflow settings" }));

    expect(getByRole("radio", { name: "Workflow" })).toBeChecked();

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
          name: "Workflow 3",
        }),
      );
    });
  });

  // #69 change 3: the builder authors definitions, and authored write paths
  // refuse the retired accessPolicy field and prose appliesTo — the seed for
  // a brand-new draft must already be authored-shape.
  it("seeds new workflows with authored-shape charter sources", async () => {
    const dispatcher = createHotkeyDispatcher();
    renderPage(dispatcher);

    await act(async () => {
      fireEvent.keyDown(document, { key: "c" });
      fireEvent.keyDown(document, { key: "w" });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(workflowMutationState.create).toHaveBeenCalled();
    });
    const payload = workflowMutationState.create.mock.calls[0]![0] as {
      definition: {
        charter: { sourcesOfTruth: Record<string, unknown>[] };
      };
    };
    for (const source of payload.definition.charter.sourcesOfTruth) {
      expect(source).not.toHaveProperty("accessPolicy");
      expect(typeof source["appliesTo"]).not.toBe("string");
    }
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

// README §5: the sidebar lists every definition with `rN · N contexts`, and the
// row carrying the draft says when that draft has unsaved work.
describe("ConnectedWorkflowBuilderPage — definitions sidebar metadata", () => {
  beforeEach(() => {
    resetStore();
    workflowMutationState.createPending = false;
    workflowMutationState.create.mockReset();
  });

  let view: ReturnType<typeof renderPage>;

  it("states a context count on every row, loaded or not", () => {
    view = renderPage();

    const sidebar = view.getByLabelText("Definitions");
    expect(
      within(sidebar).getByText(`r${record.revision} · 3 contexts`),
    ).toBeInTheDocument();
    // The unloaded row is the one the previous shape could not describe.
    expect(within(sidebar).getByText("r7 · 5 contexts")).toBeInTheDocument();
  });

  it("marks the active row unsaved while the draft is dirty", () => {
    view = renderPage();
    const sidebar = view.getByLabelText("Definitions");
    expect(within(sidebar).queryByTestId("definition-unsaved-dot")).toBeNull();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    expect(
      within(sidebar).getByTestId("definition-unsaved-dot"),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByText(`r${record.revision} · 3 contexts · unsaved`),
    ).toBeInTheDocument();
  });

  // Output-schema text the draft could not absorb leaves `dirty` false. The row
  // must still say the draft holds work, or the author loses it on a switch.
  it("marks the active row unsaved for schema text the draft cannot absorb", () => {
    view = renderPage();
    const sidebar = view.getByLabelText("Definitions");

    act(() => {
      _useGraphWorkflowBuilderStore
        .getState()
        .setPendingOutputSchemaText("context-plan", {
          text: '{ "type": ',
          committed: "",
        });
    });

    expect(_useGraphWorkflowBuilderStore.getState().dirty).toBe(false);
    expect(
      within(sidebar).getByTestId("definition-unsaved-dot"),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByText(`r${record.revision} · 3 contexts · unsaved`),
    ).toBeInTheDocument();
  });
});

describe("ConnectedWorkflowBuilderPage — managed delivery definitions", () => {
  let api: FetchFixture;

  beforeEach(() => {
    resetStore();
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

  function selectManaged(
    lifecycle: NativeSddWorkflowManagementDetail["lifecycle"],
  ): void {
    const management = managedDetail(lifecycle);
    workflowQueryState.definitions = [
      {
        id: record.id,
        name: record.name,
        description: record.description,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        management,
      },
    ];
    workflowQueryState.detail = {
      item: { ...record, management },
      resolved: resolveWorkflowDefinition(fullConfig.config, record.definition),
    };
  }

  it("routes draft proposal through the managed plan mutation and removes generic delete", async () => {
    selectManaged("draft");
    api.json(
      "POST",
      "/api/specs/test-project/checkout/actions/plan-propose",
      proposedDeliveryPlanResponse(),
    );
    const view = renderPage();

    expect(view.getByRole("link", { name: "Checkout" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Propose for review" }));
    await vi.waitFor(() =>
      expect(
        api.requestsTo("POST", /actions\/plan-propose/)[0]?.jsonBody,
      ).toEqual({}),
    );
  });

  it("saves an editable managed draft against the displayed definition revision", async () => {
    selectManaged("draft");
    const view = renderPage();
    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });

    fireEvent.click(view.getByRole("button", { name: "Save Draft" }));

    await vi.waitFor(() =>
      expect(workflowMutationState.update).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: record.revision }),
      ),
    );
  });

  it("makes an in-review candidate read-only while preserving graph inspection", () => {
    selectManaged("in_review");
    const view = renderPage();

    expect(view.getAllByText(/Read-only/).length).toBeGreaterThan(0);
    expect(view.queryByRole("button", { name: "Add Context" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save Draft" })).toBeNull();
    expect(
      view.container.querySelector('[data-testid="context-node"]'),
    ).not.toBeNull();
    expect(view.getByRole("tab", { name: "Scope" })).toBeInTheDocument();
  });
});

// The `/templates` route mounts this same page with the global tier
// (GlobalWorkflowsBuilderPage). The reworked shell is one component for both
// scopes, so parity is a claim about what the global mount actually renders.
describe("ConnectedWorkflowBuilderPage — global template scope", () => {
  beforeEach(() => {
    resetStore();
    workflowMutationState.createPending = false;
    workflowMutationState.create.mockReset();
  });

  it("renders the reworked shell with every README §5 toolbar destination", () => {
    const { getByRole, getByLabelText } = renderPage(undefined, {
      kind: "global",
    });

    // The sidebar is scoped to the global tier and still heads with create.
    const sidebar = getByLabelText("Global Templates");
    expect(
      within(sidebar).getByRole("button", { name: /New workflow/ }),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", {
        name: "Collapse global templates sidebar",
      }),
    ).toBeInTheDocument();

    for (const name of [
      "Add Context",
      "Save Draft",
      "Reset",
      "Re-layout",
      "Workflow settings",
      "Delete",
    ]) {
      expect(getByRole("button", { name })).toBeInTheDocument();
    }
    expect(getByRole("button", { name: record.name })).toBeInTheDocument();
    expect(getByRole("radio", { name: "Workflow" })).toBeChecked();
  });

  it("mounts the 420px config rail and exposes no Launch action", () => {
    const { getByRole, queryByRole } = renderPage(undefined, {
      kind: "global",
    });

    expect(getByRole("complementary", { name: "Configuration" })).toHaveClass(
      "w-[420px]",
    );
    expect(getByRole("button", { name: "Charter" })).toBeInTheDocument();
    expect(
      queryByRole("button", { name: /^launch( workflow)?$/i }),
    ).not.toBeInTheDocument();
  });

  it("switches the rail to Context scope when a context is selected", () => {
    const { getByRole } = renderPage(undefined, { kind: "global" });

    act(() => {
      _useGraphWorkflowBuilderStore.setState({
        selectedContextId: "context-plan",
      });
    });

    expect(getByRole("radio", { name: "Context" })).toBeChecked();
    expect(getByRole("button", { name: "Placement" })).toBeInTheDocument();
    // Both tabs stay navigable while a context is selected (README §5).
    expect(getByRole("radio", { name: "Workflow" })).toBeEnabled();
  });
});

// README §12 and the M1 prototype: at 768px and below the builder shows one
// primary panel at a time — Graph, Defs, Inspector — and the bottom toolbar is
// the only thing that decides which. The panel is stated on the page shell, so
// these assert the shell's own record of it rather than a CSS-resolved layout
// jsdom does not compute.
describe("ConnectedWorkflowBuilderPage — mobile panels (M1)", () => {
  beforeEach(() => {
    resetStore();
    viewportWidth = 390;
    workflowMutationState.createPending = false;
    workflowMutationState.create.mockReset();
    workflowMutationState.create.mockResolvedValue({
      item: { id: "created-workflow" },
    });
  });

  function activePanel(view: ReturnType<typeof renderPage>): string | null {
    const shell = view.container.querySelector(
      "[data-page=workflow-builder]",
    ) as HTMLElement | null;
    return shell?.getAttribute("data-mobile-panel") ?? null;
  }

  it("opens on Graph with a three-tab bottom toolbar", () => {
    const view = renderPage();

    const toolbar = view.getByRole("navigation", { name: "Builder panels" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Graph", "Defs", "Inspector"]);

    expect(activePanel(view)).toBe("graph");
    expect(
      within(toolbar).getByRole("button", { name: "Graph" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("draws the stacked lane list rather than the pannable canvas", () => {
    const view = renderPage();

    expect(view.getByTestId("workflow-mobile-graph")).toBeInTheDocument();
    expect(
      view
        .getAllByTestId("mobile-lane-band")
        .map((band) => band.getAttribute("data-lane")),
    ).toEqual(["plan", "implement", "verify"]);
    // §12: the graph's controls float above the bottom toolbar.
    expect(view.getByRole("button", { name: "Fit graph" })).toBeInTheDocument();
  });

  it("switches to the Inspector on Context scope when a context is selected", () => {
    const view = renderPage();
    expect(activePanel(view)).toBe("graph");

    const member = view
      .getAllByTestId("mobile-lane-member")
      .find((card) => card.getAttribute("data-context-id") === "context-plan");
    fireEvent.click(member as HTMLElement);

    expect(activePanel(view)).toBe("inspector");
    expect(view.getByRole("radio", { name: "Context" })).toBeChecked();
    expect(_useGraphWorkflowBuilderStore.getState().selectedContextId).toBe(
      "context-plan",
    );
    expect(
      within(
        view.getByRole("navigation", { name: "Builder panels" }),
      ).getByRole("button", { name: "Inspector" }),
    ).toHaveAttribute("aria-current", "page");
  });

  // §12: the back gesture answers the panel the reader can see. Switching away
  // leaves the config panel mounted but hidden, so it has to release the
  // history entries its drill levels stand on — otherwise the next gesture is
  // spent unwinding a stack off screen and Back appears to do nothing.
  it("releases the config panel's back entries when the toolbar leaves it", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const view = renderPage();

    fireEvent.click(
      view
        .getAllByTestId("mobile-lane-member")
        .find(
          (card) => card.getAttribute("data-context-id") === "context-plan",
        ) as HTMLElement,
    );
    fireEvent.click(view.getByRole("button", { name: /Quality gates/ }));
    expect(pushState).toHaveBeenCalledTimes(1);

    fireEvent.click(
      within(
        view.getByRole("navigation", { name: "Builder panels" }),
      ).getByRole("button", { name: "Graph" }),
    );

    expect(activePanel(view)).toBe("graph");
    expect(go).toHaveBeenCalledWith(-1);
  });

  it("loads a definition selected in Defs and returns to Graph", () => {
    const view = renderPage();

    // Get off Graph first, so the return is the switch under test.
    fireEvent.click(
      view.getAllByTestId("mobile-lane-member")[0] as HTMLElement,
    );
    expect(activePanel(view)).toBe("inspector");

    const sidebar = view.getByRole("navigation", { name: "Definitions" });
    const row = within(sidebar).getByRole("button", {
      name: /Unloaded Workflow/,
    });
    fireEvent.click(row);

    expect(activePanel(view)).toBe("graph");
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("returns to Graph after creating a workflow from Defs", async () => {
    const view = renderPage();

    fireEvent.click(
      view.getAllByTestId("mobile-lane-member")[0] as HTMLElement,
    );
    expect(activePanel(view)).toBe("inspector");

    const sidebar = view.getByRole("navigation", { name: "Definitions" });
    await act(async () => {
      fireEvent.click(
        within(sidebar).getByRole("button", { name: /New workflow/ }),
      );
      await Promise.resolve();
    });

    expect(workflowMutationState.create).toHaveBeenCalled();
    expect(activePanel(view)).toBe("graph");
  });

  // capability-preservation: the M1 action row is Add Context + Save + an
  // overflow menu, and every destination the desktop toolbar carries has to be
  // reachable through one of them.
  it("keeps every desktop toolbar destination reachable from the action row", () => {
    const view = renderPage();

    expect(
      view.getByRole("button", { name: "Add Context" }),
    ).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Save" })).toBeInTheDocument();

    fireEvent.click(
      view.getByRole("button", { name: "More workflow actions" }),
    );
    for (const name of [
      "New Lane",
      "Reset",
      "Re-layout",
      "Workflow settings",
      "Delete",
    ]) {
      expect(view.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("shows the workflow name, revision and save status in the mobile header", () => {
    const view = renderPage();

    expect(view.getByRole("button", { name: record.name })).toBeInTheDocument();
    expect(view.getByText(`r${record.revision}`)).toBeInTheDocument();
    expect(view.getByText("All changes saved")).toBeInTheDocument();

    act(() => {
      _useGraphWorkflowBuilderStore.setState({ dirty: true });
    });
    expect(view.getByTestId("workflow-save-status-dot")).toBeInTheDocument();
    expect(view.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("mounts no bottom toolbar above the mobile breakpoint", () => {
    viewportWidth = 1440;
    const view = renderPage();
    expect(
      view.queryByRole("navigation", { name: "Builder panels" }),
    ).not.toBeInTheDocument();
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
