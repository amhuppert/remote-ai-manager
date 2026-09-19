// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import ExecutionContextNode, { ContextNodeCard } from "./ExecutionContextNode";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
import type { ExecutionContextNodeData } from "./derive-graph";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

function makeData(
  overrides: Partial<ExecutionContextNodeData> = {},
): ExecutionContextNodeData {
  return {
    context: {
      id: "ctx-1",
      title: "Triage the failure report",
      acceptanceCriteria: "A verdict is recorded.",
      placement: { lane: "ctx-1", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        agent: {
          backend: "claude",
          modelSelection: {
            modelId: "sonnet",
            parameters: { effort: "medium" },
          },
        },
      },
      mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 3 },
    },
    tasks: [],
    mode: "execution",
    laneState: "active",
    configOverrides: [],
    ...overrides,
  };
}

function renderNode(data: ExecutionContextNodeData, selected = false) {
  // The full React Flow node contract, satisfied rather than asserted: a cast
  // would let the component drift onto a prop this fixture never supplies.
  const props: NodeProps<Node<ExecutionContextNodeData, "executionContext">> = {
    id: "ctx-1",
    data,
    selected,
    type: "executionContext",
    dragging: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    deletable: false,
    draggable: false,
    selectable: false,
    width: 260,
    height: 120,
    parentId: undefined,
  };

  return render(
    <ReactFlowProvider>
      <ExecutionContextNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("ExecutionContextNode — output schema glyph (R7.7)", () => {
  it("shows the validator level without parameter prefixes and emphasizes catalog max levels", () => {
    const data = makeData();
    data.context.contextValidator = {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          authority: "blocking",
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-6-astra",
              parameters: { reasoning: "xhigh", fast: "false" },
            },
          },
        },
      ],
    };
    renderNode(data);
    const crew = screen.getByTestId("node-crew");
    expect(crew).not.toHaveTextContent(/effort=|reasoning=|fast=false/);
    expect(screen.getByText("xhigh")).toHaveAttribute(
      "data-emphasis",
      "exceeds-scale",
    );
    expect(
      screen.getByRole("img", { name: "Validator general fast mode: off" }),
    ).toBeVisible();
  });

  it("renders no glyph for a context that declares no output schema", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-output-schema-glyph")).toBeNull();
  });

  it("renders a hollow, labelled glyph while a declared schema is uncaptured", () => {
    renderNode(makeData({ outputSchema: { captured: false } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    expect(glyph).toHaveAttribute("data-captured", "false");
    // The meaning must not live only in a tooltip.
    expect(glyph).toHaveAccessibleName(/output schema declared/i);
  });

  it("renders a filled green glyph once the output is captured", () => {
    renderNode(makeData({ outputSchema: { captured: true } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    expect(glyph).toHaveAttribute("data-captured", "true");
    expect(glyph).toHaveAccessibleName(/output captured/i);
  });

  it("places the glyph beside the status badge", () => {
    renderNode(makeData({ outputSchema: { captured: true } }));

    const glyph = screen.getByTestId("node-output-schema-glyph");
    const badge = screen.getByText("Pending");
    expect(glyph.parentElement).toBe(badge.parentElement);
  });
});

describe("ExecutionContextNode — skipped contexts (R13.1)", () => {
  const skipped = {
    waitState: { kind: "skipped" } as const,
    skip: {
      at: "2026-01-01T00:00:00.000Z",
      edgeEvaluations: [
        { edgeId: "e-fix", verdict: "inactive" as const },
        { edgeId: "e-seed", verdict: "omitted" as const },
      ],
      decidingEdgeIds: ["e-fix"],
    },
  };

  it("ghosts the node and names the edges that decided the skip", () => {
    const { container } = renderNode(makeData(skipped));

    const node = container.querySelector(".graph-node");
    expect(node).toHaveAttribute("data-skipped", "true");
    const reason = screen.getByTestId("node-skip-reason");
    expect(reason).toHaveTextContent("e-fix");
    // The complete verdict set is recorded, but only the guards that resolved
    // false explain the skip — an omitted edge merely dropped out.
    expect(reason).not.toHaveTextContent("e-seed");
  });

  it("leaves an unskipped node unghosted and reasonless", () => {
    const { container } = renderNode(makeData());

    expect(container.querySelector(".graph-node")).not.toHaveAttribute(
      "data-skipped",
    );
    expect(screen.queryByTestId("node-skip-reason")).toBeNull();
  });
});

describe("ExecutionContextNode — loop pass badge (R13.1)", () => {
  it("renders the pass number against the loop's declared budget", () => {
    renderNode(
      makeData({
        loop: {
          loopGroupId: "loop-a",
          pass: 2,
          maxPasses: 5,
          passCount: 2,
          activation: "running",
          templateVersion: 3,
          authoredContextId: "work",
        },
      }),
    );

    const badge = screen.getByTestId("node-loop-badge");
    expect(badge).toHaveTextContent("Pass 2/5");
    expect(badge).toHaveAccessibleName(/loop loop-a.*pass 2 of 5.*running/i);
  });

  it("renders no loop badge for a context outside every loop", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-loop-badge")).toBeNull();
  });
});

describe("ExecutionContextNode — expansion provenance (R13.1)", () => {
  it("badges a runtime-added context with its initiator", () => {
    renderNode(
      makeData({
        provenance: {
          requestId: "req-1",
          invokerContextId: "generator",
          rationale: "Fan out three candidate designs",
          payloadHash: "a".repeat(64),
          acceptedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    const badge = screen.getByTestId("node-provenance-badge");
    expect(badge).toHaveTextContent(/added at runtime/i);
    expect(badge).toHaveAccessibleName(/generator/);
    expect(badge).toHaveAccessibleName(/Fan out three candidate designs/);
  });

  it("renders no provenance badge for an authored context", () => {
    renderNode(makeData());
    expect(screen.queryByTestId("node-provenance-badge")).toBeNull();
  });
});

describe("ExecutionContextNode — advisory response phase (R6.3)", () => {
  it("distinguishes the advisory-response phase from validating and completed", () => {
    const { unmount } = renderNode(
      makeData({ waitState: { kind: "advisory-response" } }),
    );
    expect(screen.getByText("Advisory Response")).toBeInTheDocument();
    expect(screen.getByText("Awaiting advisory response")).toBeInTheDocument();
    unmount();

    renderNode(makeData({ waitState: { kind: "validating" } }));
    expect(screen.queryByText("Advisory Response")).toBeNull();
    expect(screen.getByText("Validating")).toBeInTheDocument();
    expect(screen.getByText("Validating context")).toBeInTheDocument();
  });

  it("does not read as a finished context", () => {
    const { unmount } = renderNode(
      makeData({ waitState: { kind: "advisory-response" } }),
    );
    expect(screen.queryByText("Completed")).toBeNull();
    unmount();

    // A finished context says so twice — badge and footer.
    renderNode(makeData({ waitState: { kind: "completed" } }));
    expect(screen.getAllByText("Completed")).toHaveLength(2);
  });
});

describe("ExecutionContextNode — delivery states", () => {
  /**
   * The reported defect: a context whose work is finished and certified but
   * still sitting in its lane worktree was indistinguishable from one whose
   * work had reached the session. The card has to name the difference and say
   * where the work is going.
   */
  it("says where work still in its lane is headed", () => {
    renderNode(
      makeData({
        waitState: { kind: "awaiting-merge", targetLaneName: "session" },
      }),
    );

    expect(screen.getByText("In lane")).toBeInTheDocument();
    expect(screen.getByText("Waiting to merge → session")).toBeInTheDocument();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("falls back to a bare statement when no join claims the lane", () => {
    renderNode(
      makeData({
        waitState: { kind: "awaiting-merge", targetLaneName: null },
      }),
    );

    expect(screen.getByText("Waiting to merge")).toBeInTheDocument();
  });

  it("distinguishes a lane merge in flight from one still owed", () => {
    renderNode(
      makeData({
        waitState: { kind: "merging", targetBranch: "csm/session-1" },
      }),
    );

    expect(screen.getByText("Merging")).toBeInTheDocument();
    expect(screen.getByText("Merging → csm/session-1")).toBeInTheDocument();
    expect(screen.queryByText("In lane")).toBeNull();
  });
});

describe("ExecutionContextNode — selection", () => {
  /**
   * The connection ports recolour on selection through
   * `.graph-node.selected .react-flow__handle` in workflow-graph.css, which
   * jsdom never applies. The class hook the rule depends on is therefore the
   * only part of that contract a render can assert.
   */
  it("carries the class hook the port recolour selects on", () => {
    const { unmount } = renderNode(makeData(), true);
    expect(screen.getByTestId("context-node")).toHaveClass("selected");
    unmount();

    renderNode(makeData(), false);
    expect(screen.getByTestId("context-node")).not.toHaveClass("selected");
  });
});

describe("ExecutionContextNode — card anatomy", () => {
  const checkout = {
    context: {
      ...makeData().context,
      title: "Implement checkout",
      placement: {
        lane: "delivery",
        mode: "owned" as const,
        ownedPaths: ["src/checkout", "src/risk"],
      },
      implementer: {
        id: "implementer",
        profile: { tier: "project" as const, id: "checkout-impl" },
        agent: {
          backend: "claude" as const,
          modelSelection: {
            modelId: "opus" as const,
            parameters: { effort: "high" as const },
          },
        },
      },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "security",
            profile: { tier: "global" as const, id: "security-reviewer" },
            agent: {
              backend: "claude" as const,
              modelSelection: {
                modelId: "sonnet" as const,
                parameters: { effort: "high" as const },
              },
            },
            authority: "blocking" as const,
          },
          {
            id: "style",
            profile: { tier: "project" as const, id: "style-reviewer" },
            agent: {
              backend: "codex" as const,
              modelSelection: {
                modelId: "gpt-5.6-luna" as const,
                parameters: { effort: "medium" as const },
              },
            },
            authority: "advisory" as const,
          },
        ],
      },
    },
  };

  it("renders title, status pill, lane chip, grade chip and owned paths", () => {
    renderNode(
      makeData({
        ...checkout,
        waitState: { kind: "running" },
        laneState: "active",
      }),
    );

    expect(screen.getByText("Implement checkout")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();

    const lane = screen.getByTestId("node-lane-chip");
    expect(lane).toHaveTextContent("delivery");
    expect(lane).toHaveAttribute("data-lane-state", "active");

    const gradeChip = screen.getByTestId("node-grade-chip");
    expect(gradeChip).toHaveTextContent("owning");
    expect(gradeChip).toHaveAttribute(
      "title",
      expect.stringContaining("writes only inside its declared paths"),
    );

    expect(screen.getByTestId("node-owned-paths")).toHaveTextContent(
      "src/checkout, src/risk",
    );
  });

  it("renders the crew ledger with long model names and seat authority", () => {
    renderNode(makeData(checkout));

    const crew = screen.getByTestId("node-crew");
    // The catalog's canonical long name, never the short selector id.
    expect(crew).toHaveTextContent("Opus 5");
    expect(crew).toHaveTextContent("high");

    const seats = screen.getAllByTestId("node-crew-seat");
    expect(seats).toHaveLength(2);
    expect(seats[0]).toHaveTextContent("security");
    expect(seats[0]).toHaveTextContent("blocking");
    expect(seats[0]).toHaveTextContent("Sonnet");
    expect(seats[0]).toHaveTextContent("high");
    expect(seats[1]).toHaveTextContent("style");
    expect(seats[1]).toHaveTextContent("advisory");
    expect(seats[1]).toHaveTextContent("GPT-5.6 Luna");
    expect(seats[1]).toHaveTextContent("medium");
  });

  it("names itself completely enough to be read without the visuals", () => {
    renderNode(
      makeData({
        ...checkout,
        waitState: { kind: "running" },
        contextState: {
          ...makeData().contextState,
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 5,
          completedTaskCount: 3,
        } as ExecutionContextNodeData["contextState"],
      }),
    );

    expect(screen.getByTestId("context-node")).toHaveAccessibleName(
      "Implement checkout — Running, lane delivery, owning (src/checkout, src/risk), 3 of 5 tasks, implementer Opus 5 high, inherited",
    );
  });

  it("marks configuration set on this context and puts the reason in the name", () => {
    renderNode(
      makeData({
        ...checkout,
        configOverrides: ["implementer", "iteration policy"],
      }),
    );

    expect(screen.getByTestId("node-set-here-marker")).toBeInTheDocument();
    expect(screen.getByTestId("context-node")).toHaveAccessibleName(
      /set on this context: implementer, iteration policy/,
    );
  });

  it("shows no set-here marker when every block is inherited", () => {
    renderNode(makeData(checkout));

    expect(screen.queryByTestId("node-set-here-marker")).toBeNull();
    expect(screen.getByTestId("context-node")).toHaveAccessibleName(
      /inherited/,
    );
  });

  it("marks a lane an expansion created at runtime", () => {
    renderNode(makeData({ ...checkout, laneCreatedAtRuntime: true }));

    expect(screen.getByTestId("node-runtime-lane")).toHaveTextContent(
      "runtime",
    );
  });

  it("reads Draft in the builder and Published once the lane landed", () => {
    const { unmount } = renderNode(makeData({ ...checkout, mode: "builder" }));
    expect(screen.getByText("Draft")).toBeInTheDocument();
    unmount();

    renderNode(makeData({ ...checkout, waitState: { kind: "published" } }));
    expect(screen.getByText("Published")).toBeInTheDocument();
  });

  it("pulses only while running", () => {
    const { unmount } = renderNode(
      makeData({ ...checkout, waitState: { kind: "running" } }),
    );
    expect(screen.getByTestId("context-node")).toHaveClass("node-live-pulse");
    unmount();

    renderNode(makeData({ ...checkout, waitState: { kind: "completed" } }));
    expect(screen.getByTestId("context-node")).not.toHaveClass(
      "node-live-pulse",
    );
  });

  it("explains why a full-grade member is queued behind its lane", () => {
    renderNode(
      makeData({
        context: {
          ...checkout.context,
          placement: { lane: "delivery", mode: "full" },
        },
        waitState: { kind: "waiting-for-lane", laneId: "delivery" },
      }),
    );

    const notice = screen.getByTestId("node-notice");
    expect(notice).toHaveAttribute("data-tone", "amber");
    expect(notice).toHaveTextContent(
      "Full grade — waits for exclusive occupancy of delivery.",
    );
  });

  it("shows no notice for a healthy context", () => {
    renderNode(makeData({ ...checkout, waitState: { kind: "running" } }));
    expect(screen.queryByTestId("node-notice")).toBeNull();
  });
});

describe("node agent configuration", () => {
  it("closes the previous dropdown when another field or node is opened", () => {
    render(
      <>
        <ContextNodeCard
          data={makeData({ agentEditor: { onChange: vi.fn() } })}
          selected={false}
        />
        <ContextNodeCard
          data={makeData({ agentEditor: { onChange: vi.fn() } })}
          selected={false}
        />
      </>,
    );
    const [firstBackend, secondBackend] = screen.getAllByRole("combobox", {
      name: "Implementer backend",
    });
    const firstModel = screen.getAllByRole("combobox", {
      name: "Implementer model",
    })[0]!;
    fireEvent.keyDown(firstBackend!, { key: "Enter" });
    expect(firstBackend).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(firstModel, { key: "Enter" });
    expect(firstBackend).toHaveAttribute("aria-expanded", "false");
    expect(firstModel).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("listbox", { hidden: true })).toHaveLength(1);
    fireEvent.keyDown(secondBackend!, { key: "Enter" });
    expect(firstModel).toHaveAttribute("aria-expanded", "false");
    expect(secondBackend).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("listbox", { hidden: true })).toHaveLength(1);
  });

  it("changes the implementer level directly and does not select the context", () => {
    const onChange = vi.fn();
    const data = makeData({ agentEditor: { onChange } });
    renderNode(data);
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Implementer level" }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(onChange).toHaveBeenCalledWith(
      { kind: "implementer" },
      {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
      },
    );
  });

  it("has no editable controls when the host does not grant editing", () => {
    renderNode(makeData());
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("disables configuration while saving and shows failures on the node", () => {
    renderNode(
      makeData({
        agentEditor: {
          onChange: vi.fn(),
          pending: true,
          error: "Revision changed. Try again.",
        },
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Implementer model" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    expect(screen.getByRole("alert")).toHaveTextContent("Revision changed");
  });
});

it("switches backend to its valid default selection", () => {
  const onChange = vi.fn();
  renderNode(makeData({ agentEditor: { onChange } }));
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Implementer backend" }),
    { key: "Enter" },
  );
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  const catalog = getConfiguredBackendModelCatalog("codex");
  expect(onChange).toHaveBeenCalledWith(
    { kind: "implementer" },
    {
      backend: "codex",
      modelSelection: defaultSelectionForModel(catalog, catalog.defaultModelId),
    },
  );
});

it("changes a model to its supported parameter defaults", () => {
  const onChange = vi.fn();
  renderNode(makeData({ agentEditor: { onChange } }));
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Implementer model" }),
    { key: "Enter" },
  );
  fireEvent.click(screen.getByRole("option", { name: "Opus 5" }));
  expect(onChange).toHaveBeenCalledWith(
    { kind: "implementer" },
    {
      backend: "claude",
      modelSelection: defaultSelectionForModel(
        getConfiguredBackendModelCatalog("claude"),
        "opus",
      ),
    },
  );
});

it("changes an existing validator's fast mode while keeping its model and level", () => {
  const onChange = vi.fn();
  const data = makeData({ agentEditor: { onChange } });
  data.context.contextValidator = {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        authority: "blocking",
        agent: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-6-astra",
            parameters: { reasoning: "ultra", fast: "false" },
          },
        },
      },
    ],
  };
  const { unmount } = renderNode(data);
  const toggle = screen.getByRole("button", {
    name: "Validator general fast mode",
  });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onChange).toHaveBeenCalledWith(
    { kind: "validator", assignmentId: "general" },
    {
      backend: "codex",
      modelSelection: {
        modelId: "gpt-6-astra",
        parameters: { reasoning: "ultra", fast: "true" },
      },
    },
  );
  expect(
    screen.queryByRole("button", { name: /add.*validator|remove.*validator/i }),
  ).toBeNull();
  unmount();
  data.context.contextValidator.assignments[0]!.agent =
    onChange.mock.calls[0]![1];
  renderNode(data);
  const enabledToggle = screen.getByRole("button", {
    name: "Validator general fast mode",
  });
  expect(enabledToggle).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(enabledToggle);
  expect(onChange).toHaveBeenLastCalledWith(
    { kind: "validator", assignmentId: "general" },
    {
      backend: "codex",
      modelSelection: {
        modelId: "gpt-6-astra",
        parameters: { reasoning: "ultra", fast: "false" },
      },
    },
  );
});

it("lets clicks on read-only agent details select the context", () => {
  const select = vi.fn();
  render(
    <div onClick={select}>
      <ContextNodeCard data={makeData()} selected={false} />
    </div>,
  );
  fireEvent.click(screen.getByText("Sonnet"));
  expect(select).toHaveBeenCalledTimes(1);
});

it("keeps a configured custom Codex model editable", () => {
  const onChange = vi.fn();
  const data = makeData({ agentEditor: { onChange } });
  data.context.implementer!.agent = {
    backend: "codex",
    modelSelection: {
      modelId: "custom-codex-review",
      parameters: { reasoning: "xhigh", fast: "false" },
    },
  };
  renderNode(data);
  fireEvent.keyDown(
    screen.getByRole("combobox", { name: "Implementer level" }),
    { key: "Enter" },
  );
  fireEvent.click(screen.getByRole("option", { name: "High" }));
  expect(onChange).toHaveBeenCalledWith(
    { kind: "implementer" },
    {
      backend: "codex",
      modelSelection: {
        modelId: "custom-codex-review",
        parameters: { reasoning: "high", fast: "false" },
      },
    },
  );
});

it("keeps inline agent control clicks from selecting the context", () => {
  const select = vi.fn();
  render(
    <div onClick={select}>
      <ContextNodeCard
        data={makeData({ agentEditor: { onChange: vi.fn() } })}
        selected={false}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Implementer model" }));
  expect(select).not.toHaveBeenCalled();
});
