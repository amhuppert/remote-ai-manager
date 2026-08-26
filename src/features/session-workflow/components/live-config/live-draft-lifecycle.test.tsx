// @vitest-environment jsdom
/**
 * The live draft's lifecycle across re-renders, migrated from the retired
 * ContextConfigTab suite onto the new panel.
 *
 * Everything here is a claim about state the panel HOLDS between renders —
 * three-way rebase on a conflict refetch, re-seeding on a selection change, and
 * the output-schema submission that must not settle until the server is
 * observed to agree. The pure pieces are unit-covered in `live-context-draft`;
 * what these tests own is the panel actually wiring them in the right order,
 * which no unit test can show.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import LiveContextConfigPanel from "./LiveContextConfigPanel";

const CONTEXT_ID = "context-impl";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};
const SCHEMA_TEXT = JSON.stringify(SCHEMA, null, 2);

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function context(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: CONTEXT_ID,
    title: "Implement",
    description: "Do the work",
    acceptanceCriteria: "It works",
    placement: { lane: "delivery", mode: "full" },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    ...overrides,
  };
}

function startedState(): GraphWorkflowExecutionContextState {
  return {
    skipReason: null,
    landingIntent: null,
    contextId: CONTEXT_ID,
    status: "running",
    totalTaskCount: 2,
    completedTaskCount: 1,
    iterationCount: 3,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
    worktreePath: "/tmp/wt",
    branchName: "csm/impl",
    isolation: "worktree",
    batchId: "batch-1",
    laneId: "delivery",
    joinId: "join-1",
    mergeStatus: "pending",
    cleanupStatus: "pending",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInputs: {},
  };
}

/** Paused → quiescent → the whole surface is editable. */
function execution(
  resolved: GraphWorkflowResolvedContext = context(),
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: [resolved],
      tasks: [],
      edges: [],
    },
    activeContextIds: [],
    contextStates: {
      [resolved.id]: { ...startedState(), contextId: resolved.id },
    },
    taskStates: {},
    ...overrides,
  });
}

function panel(props: {
  execution: GraphWorkflowExecution;
  contextId?: string;
  onSaveContextConfig: ReturnType<typeof vi.fn>;
  focusScreen: readonly string[];
  editConflict?: boolean;
  isSaving?: boolean;
  saveSucceeded?: boolean;
  onResumeExecution?: () => void;
}): React.JSX.Element {
  const {
    execution: exec,
    contextId = CONTEXT_ID,
    onSaveContextConfig,
    focusScreen,
    ...rest
  } = props;
  return (
    <LiveContextConfigPanel
      execution={exec}
      contextId={contextId}
      onSaveContextConfig={onSaveContextConfig}
      focusScreen={focusScreen}
      {...rest}
    />
  );
}

const save = () => screen.getByRole("button", { name: "Save changes" });
const schemaEditor = () => screen.getByLabelText("Output schema JSON");
const maxIterations = () => screen.getByLabelText("Max iterations");

describe("live draft — revision-conflict recovery", () => {
  it("keeps an unsaved edit across the refetch a conflict triggers", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(),
        onSaveContextConfig,
        focusScreen: ["policy"],
      }),
    );

    fireEvent.change(maxIterations(), { target: { value: "12" } });
    // Submit, so the conflict being reported is THIS context's own.
    fireEvent.click(save());

    // The refetch after a 409 delivers a fresh execution object for the same
    // context, plus the conflict flag. The user's edit must survive it.
    const refreshed = execution();
    refreshed.liveRevision = 7;
    rerender(
      panel({
        execution: refreshed,
        onSaveContextConfig,
        focusScreen: ["policy"],
        editConflict: true,
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/execution changed/i);
    expect(maxIterations()).toHaveValue(12);
    expect(save()).toBeEnabled();
  });

  it("rebases: keeps the user's edit and drops a concurrently-changed field from the retry", () => {
    // The lost-update guard. Diffing against the SEED baseline rather than the
    // fresh execution is what keeps someone else's rename out of our payload.
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(),
        onSaveContextConfig,
        focusScreen: ["policy"],
      }),
    );

    fireEvent.change(maxIterations(), { target: { value: "12" } });

    const concurrent = execution(
      context({ title: "Renamed by another editor" }),
    );
    concurrent.liveRevision = 9;
    rerender(
      panel({
        execution: concurrent,
        onSaveContextConfig,
        focusScreen: ["policy"],
        editConflict: true,
      }),
    );

    expect(maxIterations()).toHaveValue(12);

    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: CONTEXT_ID,
        iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
      },
    ]);
  });

  it("adopts the concurrent value on a field the author never touched", () => {
    // The other half of the rebase: an untouched field is not frozen at the
    // baseline, it takes the fresh value — otherwise the panel would show a
    // stale document and quietly re-submit it later.
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(),
        onSaveContextConfig,
        focusScreen: ["brief"],
      }),
    );

    fireEvent.change(screen.getByLabelText("Context title"), {
      target: { value: "My retitle" },
    });

    const concurrent = execution(
      context({ title: "Implement", description: "Rewritten by someone else" }),
    );
    concurrent.liveRevision = 11;
    rerender(
      panel({
        execution: concurrent,
        onSaveContextConfig,
        focusScreen: ["brief"],
        editConflict: true,
      }),
    );

    expect(screen.getByLabelText("Context title")).toHaveValue("My retitle");
    expect(screen.getByLabelText("Context description")).toHaveValue(
      "Rewritten by someone else",
    );

    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, title: "My retitle" },
    ]);
  });
});

describe("live draft — selection changes", () => {
  it("re-seeds wholesale when the selected context changes", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(),
        onSaveContextConfig,
        focusScreen: ["policy"],
      }),
    );

    fireEvent.change(maxIterations(), { target: { value: "99" } });

    const other = context({
      id: "context-other",
      iterationPolicy: { maxIterations: 15, continuity: { enabled: true } },
    });
    rerender(
      panel({
        execution: execution(other),
        contextId: "context-other",
        onSaveContextConfig,
        focusScreen: ["policy"],
      }),
    );

    // The other context's own value, not the abandoned edit.
    expect(maxIterations()).toHaveValue(15);
  });
});

describe("live draft — the output-schema submission", () => {
  const schemaContext = () => context({ outputSchema: SCHEMA });

  function landed(
    saved: Record<string, unknown> | undefined,
  ): GraphWorkflowExecution {
    const next = execution(
      saved === undefined ? context() : context({ outputSchema: saved }),
    );
    next.liveRevision = 21;
    return next;
  }

  it("settles clean once a formatting-only edit is observed to have landed", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(schemaContext()),
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    // Same document, compact text — the op still carries an equal document.
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(SCHEMA) },
    });
    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, outputSchema: SCHEMA },
    ]);

    rerender(
      panel({
        execution: landed(SCHEMA),
        onSaveContextConfig,
        focusScreen: ["schema"],
        saveSucceeded: true,
      }),
    );

    // Adopting the canonical serialization is what settles it: raw text that
    // differs only in formatting would otherwise stay dirty against itself.
    expect(schemaEditor()).toHaveValue(SCHEMA_TEXT);
    expect(save()).toBeDisabled();
  });

  it("settles clean after a clear round-trips", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(schemaContext()),
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    fireEvent.change(schemaEditor(), { target: { value: "" } });
    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, outputSchema: null },
    ]);

    rerender(
      panel({
        execution: landed(undefined),
        onSaveContextConfig,
        focusScreen: ["schema"],
        saveSucceeded: true,
      }),
    );

    expect(schemaEditor()).toHaveValue("");
    expect(save()).toBeDisabled();
  });

  it("does not settle a formatting-only edit before the save lands", () => {
    // Dispatch is not acknowledgement. The stored document ALREADY equals what
    // we sent, so without the revision check this would settle instantly.
    const onSaveContextConfig = vi.fn();
    const compact = JSON.stringify(SCHEMA);
    const stable = execution(schemaContext());
    const { rerender } = render(
      panel({
        execution: stable,
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(save());

    rerender(
      panel({
        execution: stable,
        onSaveContextConfig,
        focusScreen: ["schema"],
        isSaving: true,
      }),
    );

    expect(schemaEditor()).toHaveValue(compact);
  });

  it("keeps a formatting-only edit in the retry payload when the save conflicts", () => {
    // The case a canonicalize-on-dispatch baseline loses silently: the
    // submitted document equals the baseline document, so normalizing early
    // would make the draft read as untouched — the rebase would then adopt the
    // concurrent schema and drop the submitted intent entirely.
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(schemaContext()),
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    const compact = JSON.stringify(SCHEMA);
    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(save());
    onSaveContextConfig.mockClear();

    const theirs = {
      type: "object",
      properties: { theirs: { type: "number" } },
    };
    rerender(
      panel({
        execution: landed(theirs),
        onSaveContextConfig,
        focusScreen: ["schema"],
        editConflict: true,
      }),
    );

    expect(schemaEditor()).toHaveValue(compact);
    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, outputSchema: SCHEMA },
    ]);
  });

  it("keeps a rejected schema save dirty and retries with the author's own document", () => {
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      panel({
        execution: execution(schemaContext()),
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    const mine = { type: "object", properties: { mine: { type: "string" } } };
    fireEvent.change(schemaEditor(), {
      target: { value: JSON.stringify(mine) },
    });
    fireEvent.click(save());
    onSaveContextConfig.mockClear();

    const theirs = {
      type: "object",
      properties: { theirs: { type: "number" } },
    };
    rerender(
      panel({
        execution: landed(theirs),
        onSaveContextConfig,
        focusScreen: ["schema"],
        editConflict: true,
      }),
    );

    // The rejection leaves the author's text in place, unnormalized.
    expect(schemaEditor()).toHaveValue(JSON.stringify(mine));
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, outputSchema: mine },
    ]);
  });

  it("holds a pending edit through an unrelated revision bump, then retries it on conflict", () => {
    // A moved revision proves SOME write landed, not that ours did. Only the
    // mutation's own success may settle a submission — otherwise an unrelated
    // concurrent edit acknowledges a save whose outcome is still unknown, and a
    // later conflict finds the raw text already canonicalized away.
    const onSaveContextConfig = vi.fn();
    const compact = JSON.stringify(SCHEMA);
    const { rerender } = render(
      panel({
        execution: execution(schemaContext()),
        onSaveContextConfig,
        focusScreen: ["schema"],
      }),
    );

    fireEvent.change(schemaEditor(), { target: { value: compact } });
    fireEvent.click(save());
    onSaveContextConfig.mockClear();

    // Someone else's edit bumps the revision while our save is still in flight.
    const bumped = execution(schemaContext());
    bumped.liveRevision = 42;
    rerender(
      panel({
        execution: bumped,
        onSaveContextConfig,
        focusScreen: ["schema"],
        isSaving: true,
      }),
    );
    expect(schemaEditor()).toHaveValue(compact);

    rerender(
      panel({
        execution: bumped,
        onSaveContextConfig,
        focusScreen: ["schema"],
        editConflict: true,
      }),
    );
    fireEvent.click(save());
    expect(onSaveContextConfig).toHaveBeenCalledWith([
      { type: "update-context", contextId: CONTEXT_ID, outputSchema: SCHEMA },
    ]);
  });
});
