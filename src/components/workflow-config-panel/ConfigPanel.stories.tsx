import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { fn } from "storybook/test";
import { OUTPUT_SCHEMA_TEMPLATE } from "@/components/workflow-config/OutputSchemaField";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { makeImplementerAssignment } from "@/lib/workflow-graph/test-fixtures";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import {
  ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF,
  type ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { cascadeScreens } from "./cascade-screens";
import {
  applyConfigEditToContext,
  applyConfigEditToWorkflowConfig,
  createConfigCascade,
  overrideCountLabel,
  type ConfigEditIntent,
} from "./config-cascade";
import { ConfigPanel } from "./ConfigPanel";
import { seatScreenId } from "./navigation-ids";
import { buildContextRootCards, buildWorkflowRootCards } from "./root-cards";
import {
  createConfigScreenRegistry,
  type ConfigScreenDefinition,
  type ConfigScreenRegistry,
} from "./screen-registry";
import type { ConfigScope } from "./types";

/**
 * The panel as the two hosts mount it, over the REAL cascade screens.
 *
 * The fixture is the design bundle's shared one: a context that overrides its
 * circuit breaker and one collaboration field, inside a workflow that overrides
 * its approval gate and one validation role — so every provenance state and
 * every override granularity is on screen at once.
 *
 * The harness is stateful and applies each screen's intent through the real
 * appliers, which is what makes the cascade stories demonstrations rather than
 * pictures: promoting a field, resetting a block and re-enabling a dormant
 * cohort all move the tier chips live.
 *
 * Only the STRUCTURAL cards (Brief, Placement, Tasks, Charter, Launch
 * parameters) stand in as stubs here — they are built and storied by their own
 * screen context, and this file would otherwise carry a second fixture for
 * charters, tasks and upstream inputs that nothing on these screens reads.
 */

const PROJECT = "checkout";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "general-implementer" },
      name: "General Implementer",
      description: "Implements a context's tasks.",
      revision: 1,
      recommendedFor: ["workflow_implementer"],
      tags: [],
      readOnly: true,
    },
    {
      ref: ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF,
      name: "General Reviewer",
      description: "Reviews a diff against the context's acceptance criteria.",
      revision: 1,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "project", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Reads a diff for exploitable defects.",
      revision: 4,
      recommendedFor: ["workflow_validator"],
      tags: ["security"],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

/** Stands in for the project's live registry query on the canvas. */
const VALIDATION_COMMANDS: readonly ValidationCommandSummary[] = [
  {
    name: "format",
    cost: 1,
    description: "Prettier over the changed files",
    pathArgs: "paths",
    changedScope: "native",
  },
  {
    name: "lint",
    cost: 2,
    description: "ESLint and the seam ratchet",
    pathArgs: "paths",
    changedScope: "native",
  },
  {
    name: "typecheck",
    cost: 2,
    description: "tsc across the project",
    pathArgs: "forbid",
    changedScope: "full_fallback",
  },
  {
    name: "test",
    cost: 5,
    description: "Vitest, narrowed to the diff",
    pathArgs: "paths",
    changedScope: "native",
  },
];

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  acceptanceCriteria: [
    { id: "ac-1", statement: "Every attempt writes exactly one audit row." },
    { id: "ac-2", statement: "A declined card never reserves inventory." },
  ],
  placement: {
    lane: "delivery",
    mode: "owned",
    ownedPaths: ["src/checkout/", "src/payments/"],
  },
  circuitBreaker: { consecutiveFailureThreshold: 5 },
  // One field of the block, deliberately different from the inherited value —
  // a per-field override that resolves to the same number as its parent would
  // demonstrate nothing.
  collaboration: { negotiationRounds: 5 },
};

const WORKFLOW_CONFIG: WorkflowConfigOverride = {
  humanApprovalGate: { enabled: true },
  agentValidation: {
    contextValidator: { mode: "only", commands: ["typecheck", "test"] },
  },
};

/**
 * A cohort switched off with its roster intact — the state the lossless
 * re-enable rule exists for.
 */
const DORMANT_COHORT: ValidatorCohort = {
  enabled: false,
  assignments: [
    {
      id: "general",
      profile: ACCEPTANCE_CRITERIA_VALIDATOR_PROFILE_REF,
      strategy: "conversation",
      authority: "blocking",
      continuity: { enabled: true },
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
    },
    {
      id: "security",
      profile: { tier: "project", id: "security-reviewer" },
      strategy: "task",
      authority: "advisory",
      focus: "auth boundaries and session fixation",
      continuity: { enabled: false },
      agent: {
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
    },
  ],
};

const CONTEXT_META = [
  CONTEXT.id,
  `lane ${CONTEXT.placement.lane}`,
  CONTEXT.placement.mode === "owned"
    ? `owning · ${CONTEXT.placement.ownedPaths.join(", ")}`
    : CONTEXT.placement.mode,
].join(" · ");

const STRUCTURAL_STUBS: Record<ConfigScope, readonly string[]> = {
  context: ["brief", "placement", "tasks"],
  workflow: ["charter", "params"],
};

const STUB_TITLE: Record<string, string> = {
  brief: "Brief",
  placement: "Placement",
  tasks: "Tasks",
  charter: "Charter",
  params: "Launch parameters",
};

function registryFor(
  scope: ConfigScope,
  editor: ConfigCascadeEditor,
): ConfigScreenRegistry {
  const stubs: ConfigScreenDefinition[] = STRUCTURAL_STUBS[scope].map((id) => ({
    id,
    title: STUB_TITLE[id] ?? id,
    render: () => (
      <p className="m-0 font-mono text-[0.72rem] leading-[1.6] text-text-tertiary">
        {STUB_TITLE[id] ?? id} is built by its own screen context.
      </p>
    ),
  }));
  return createConfigScreenRegistry([...stubs, ...cascadeScreens(editor)]);
}

/** The 420px right rail, at the panel's real height. */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[820px] w-[420px] max-w-[calc(100vw-32px)] border border-solid border-border-dim">
      {children}
    </div>
  );
}

function Canvas({ children }: { children: React.ReactNode }) {
  // The profile pickers read the production library query, so the canvas seeds
  // its cache rather than passing options in — the screens then exercise the
  // same wiring a real host gives them.
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
    queryClient.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
    return queryClient;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type PanelProps = React.ComponentProps<typeof ConfigPanel>;

interface HarnessProps extends Omit<
  Partial<PanelProps>,
  "scope" | "onScopeChange" | "screens"
> {
  host: PanelProps["host"];
  initialScope?: ConfigScope;
  contextOverrides?: Partial<GraphWorkflowExecutionContextDefinition>;
  workflowOverrides?: WorkflowConfigOverride;
}

/**
 * A live draft over the real cascade: an intent from any screen lands through
 * the applier that owns its tier, and the next render resolves from the result.
 */
function Panel({
  host,
  initialScope = "context",
  contextOverrides,
  workflowOverrides,
  ...overrides
}: HarnessProps): React.JSX.Element {
  const [scope, setScope] = useState<ConfigScope>(initialScope);
  const [context, setContext] = useState({ ...CONTEXT, ...contextOverrides });
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfigOverride>({
    ...WORKFLOW_CONFIG,
    ...workflowOverrides,
  });

  const cascade = createConfigCascade({
    scope,
    globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig,
    context,
  });

  const onEdit = (intent: ConfigEditIntent) => {
    if (scope === "context") {
      setContext((current) => applyConfigEditToContext(intent, current));
      return;
    }
    setWorkflowConfig((current) =>
      applyConfigEditToWorkflowConfig(intent, current),
    );
  };

  const editor: ConfigCascadeEditor = {
    host,
    affordance: overrides.affordance ?? "editable",
    cascade,
    onEdit,
    validationCommands: VALIDATION_COMMANDS,
    libraryProjectName: PROJECT,
  };

  return (
    <Canvas>
      <Rail>
        <ConfigPanel
          host={host}
          scope={scope}
          onScopeChange={host === "builder" ? setScope : undefined}
          entityTitle={
            scope === "context" ? context.title : "checkout-v2 release train"
          }
          entityMeta={
            scope === "context"
              ? CONTEXT_META
              : "6 contexts · defaults every context inherits unless it overrides them"
          }
          overrideSummary={overrideCountLabel(cascade.counts())}
          hasOverrides={cascade.paths.some((path) => cascade.own(path))}
          rootCards={
            scope === "context"
              ? buildContextRootCards({
                  cascade,
                  context,
                  outputSchemaText: OUTPUT_SCHEMA_TEMPLATE,
                  upstreamInputCount: 2,
                  taskCount: 4,
                  nextTaskTitle: "Reserve inventory before authorising",
                })
              : buildWorkflowRootCards({
                  cascade,
                  invariantCount: 3,
                  sourceCount: 5,
                  parameters: [
                    {
                      id: "targetBranch",
                      type: "string",
                      required: true,
                      defaultValue: null,
                    },
                    {
                      id: "dryRun",
                      type: "boolean",
                      required: false,
                      defaultValue: "false",
                    },
                  ],
                })
          }
          screens={registryFor(scope, editor)}
          onResetAll={() => onEdit(cascade.resetAll())}
          {...overrides}
        />
      </Rail>
    </Canvas>
  );
}

const meta = {
  title: "WorkflowConfigPanel/ConfigPanel",
  component: ConfigPanel,
  parameters: { layout: "centered" },
  args: {
    host: "builder",
    scope: "context",
    entityTitle: CONTEXT.title,
    entityMeta: CONTEXT_META,
    rootCards: [],
    screens: createConfigScreenRegistry([]),
  },
} satisfies Meta<typeof ConfigPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The builder host: scope switch, override counts, legend footer. */
export const BuilderContextScope: Story = {
  render: () => <Panel host="builder" />,
};

export const BuilderWorkflowScope: Story = {
  render: () => <Panel host="builder" initialScope="workflow" />,
};

/**
 * Push navigation three levels deep over the real screens: Quality gates →
 * Cohort roster → one seat. Each level fills the panel and its back row names
 * the level above; going back restores the scroll position and the focus of the
 * row that was opened.
 */
export const PushNavigation: Story = {
  render: () => (
    <Panel
      host="builder"
      initialScreenPath={["gates", "validator", seatScreenId("general")]}
    />
  ),
};

/**
 * Per-FIELD cascade. The context sets negotiation rounds and nothing else in
 * the block, so that row alone wears the cyan edge and a field-level reset
 * while `Collaboration`, `Second agent` and `Auto-resolve threshold` still
 * resolve from the global tier. Moving any one of them leaves the other three
 * exactly where they were, and resetting the edited row restores its
 * inheritance without touching its siblings.
 */
export const CollaborationFieldCascade: Story = {
  render: () => (
    <Panel host="builder" initialScreenPath={["agents", "collab"]} />
  ),
};

/**
 * Per-ROLE cascade. The workflow sets the context-validator selector and the
 * implementer inherits, so the two sections read their own tiers. Editing the
 * implementer's mode promotes that role to the context and the context
 * validator's provenance does not move.
 */
export const AgentValidationRoleIndependence: Story = {
  render: () => (
    <Panel host="builder" initialScreenPath={["gates", "agentval"]} />
  ),
};

/**
 * Per-BLOCK reset. The context overrides its circuit breaker, so `Failure
 * threshold` carries the reset affordance; taking it clears the whole block and
 * the row falls back to the global default. The iteration policy beside it is
 * untouched — a block reset clears exactly its own block.
 */
export const BlockReset: Story = {
  render: () => <Panel host="builder" initialScreenPath={["policy"]} />,
};

/**
 * The dormant cohort. Validation is off, but the roster it would restore is
 * still on screen and still ordered — the move, remove and add affordances stay
 * visible and disabled rather than disappearing, so re-enabling reads as a
 * restore and not a fresh seed.
 */
export const DormantValidatorCohort: Story = {
  render: () => (
    <Panel
      host="builder"
      contextOverrides={{ contextValidator: DORMANT_COHORT }}
      initialScreenPath={["gates", "validator"]}
    />
  ),
};

/** Lane-merge validation, which exists at the workflow tier alone. */
export const LaneMergeValidation: Story = {
  render: () => (
    <Panel
      host="builder"
      initialScope="workflow"
      initialScreenPath={["gates", "lanemerge"]}
    />
  ),
};

/** The execution host: no scope switch, no legend, and a save bar instead. */
export const ExecutionEditable: Story = {
  render: () => (
    <Panel
      host="execution"
      affordance="editable"
      saveState="clean"
      onSave={fn()}
      onResume={fn()}
      onPauseToEdit={fn()}
    />
  ),
};

export const ExecutionDirty: Story = {
  render: () => (
    <Panel
      host="execution"
      affordance="editable"
      saveState="dirty"
      onSave={fn()}
    />
  ),
};

export const ExecutionSaved: Story = {
  render: () => (
    <Panel
      host="execution"
      affordance="editable"
      saveState="saved"
      onSave={fn()}
      onResume={fn()}
    />
  ),
};

export const ExecutionConflict: Story = {
  render: () => (
    <Panel
      host="execution"
      affordance="editable"
      saveState="conflict"
      onSave={fn()}
    />
  ),
};

export const ExecutionPauseToEdit: Story = {
  render: () => (
    <Panel host="execution" affordance="pause-to-edit" onPauseToEdit={fn()} />
  ),
};

export const ExecutionFrozen: Story = {
  render: () => <Panel host="execution" affordance="frozen" />,
};

export const ExecutionReadOnly: Story = {
  render: () => (
    <Panel
      host="execution"
      affordance="read-only"
      readOnlyReason="awaiting-definition-approval"
    />
  ),
};

export const CursorImplementer: Story = {
  render: () => (
    <Panel
      host="builder"
      initialScreenPath={["agents", "implementer"]}
      contextOverrides={{
        implementer: makeImplementerAssignment({
          backend: "cursor",
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "false" },
          },
        }),
      }}
    />
  ),
};
