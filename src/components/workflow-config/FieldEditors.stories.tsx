import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type { WorkflowCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  AgentAssignment,
  ValidatorAssignment,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  GraphWorkflowPlanRepairPolicy,
} from "@/lib/workflow-graph/config-schemas";
import {
  CircuitBreakerEditor,
  CollaborationEditor,
  ContextValidatorEditor,
  ImplementerEditor,
  IterationPolicyEditor,
  PlanRepairEditor,
} from "./FieldEditors";

// The assignment editors read their options through the production library
// query, so the canvas seeds that query's cache instead of passing options in.
const PROJECT = "acme-web";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "general-implementer" },
      name: "General Implementer",
      description: "Command Center's default implementer.",
      revision: 1,
      recommendedFor: ["workflow_implementer"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "builtin", id: "general-reviewer" },
      name: "General Reviewer",
      description: "Reviews a diff against acceptance criteria.",
      revision: 1,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: true,
    },
  ],
  diagnostics: [],
};

const IMPLEMENTER: AgentAssignment = {
  id: "implementer",
  profile: { tier: "builtin", id: "general-implementer" },
  agent: {
    backend: "claude",
    model: "opus",
    reasoningEffort: "high",
  },
};

const VALIDATOR: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin", id: "general-reviewer" },
  strategy: "conversation",
  authority: "blocking",
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  continuity: { enabled: true },
};

const ITERATION: GraphWorkflowIterationPolicy = {
  maxIterations: 20,
  continuity: { enabled: true },
};

const CIRCUIT_BREAKER: GraphWorkflowCircuitBreakerPolicy = {
  consecutiveFailureThreshold: 3,
};

const PLAN_REPAIR: GraphWorkflowPlanRepairPolicy = {
  enabled: true,
  maxAttemptsPerContext: 2,
};

const COLLABORATION: WorkflowCollaborationConfig = {
  enabled: false,
  secondAgent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

function Panel({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
    return queryClient;
  });
  return (
    <QueryClientProvider client={client}>
      <div
        style={{ width: 380, padding: 16, background: "var(--bg-surface)" }}
        className="flex flex-col gap-lg"
      >
        {children}
      </div>
    </QueryClientProvider>
  );
}

// Standalone harness so each editor is interactive in the story canvas; the
// editors are pure value+onChange, so local state is the only wiring needed.
function AllEditors({ readOnly }: { readOnly?: boolean }) {
  const [implementer, setImplementer] = useState<AgentAssignment>(IMPLEMENTER);
  const [validator, setValidator] = useState<ValidatorAssignment>(VALIDATOR);
  const [iteration, setIteration] =
    useState<GraphWorkflowIterationPolicy>(ITERATION);
  const [circuitBreaker, setCircuitBreaker] =
    useState<GraphWorkflowCircuitBreakerPolicy>(CIRCUIT_BREAKER);
  const [collaboration, setCollaboration] =
    useState<WorkflowCollaborationConfig>(COLLABORATION);
  const [planRepair, setPlanRepair] =
    useState<GraphWorkflowPlanRepairPolicy>(PLAN_REPAIR);

  return (
    <Panel>
      <ImplementerEditor
        value={implementer}
        onChange={setImplementer}
        libraryProjectName={PROJECT}
        readOnly={readOnly}
      />
      <ContextValidatorEditor
        value={validator}
        onChange={setValidator}
        libraryProjectName={PROJECT}
        readOnly={readOnly}
      />
      <IterationPolicyEditor
        value={iteration}
        onChange={setIteration}
        readOnly={readOnly}
      />
      <CircuitBreakerEditor
        value={circuitBreaker}
        onChange={setCircuitBreaker}
        readOnly={readOnly}
      />
      <PlanRepairEditor
        value={planRepair}
        onChange={setPlanRepair}
        readOnly={readOnly}
      />
      <CollaborationEditor
        value={collaboration}
        onChange={setCollaboration}
        readOnly={readOnly}
      />
    </Panel>
  );
}

const meta = {
  title: "WorkflowConfig/FieldEditors",
  component: ImplementerEditor,
  args: { value: IMPLEMENTER, onChange: fn() },
} satisfies Meta<typeof ImplementerEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editable: Story = {
  render: () => <AllEditors />,
};

export const ReadOnly: Story = {
  render: () => <AllEditors readOnly />,
};

/**
 * The same seat under each authority, side by side: one field, two forces
 * (R12.2). Blocking reads as the mandate its issues must trace to; advisory
 * reads as a subordinate steer inside the profile block.
 */
export const AuthorityFaces: Story = {
  render: () => {
    const AuthorityHarness = () => {
      const [blocking, setBlocking] = useState<ValidatorAssignment>({
        ...VALIDATOR,
        id: "general",
        authority: "blocking",
        focus: "the context's acceptance criteria, and nothing beyond them",
      });
      const [advisory, setAdvisory] = useState<ValidatorAssignment>({
        ...VALIDATOR,
        id: "security",
        authority: "advisory",
        focus: "auth boundaries and session fixation",
      });
      return (
        <Panel>
          <ContextValidatorEditor
            value={blocking}
            onChange={setBlocking}
            libraryProjectName={PROJECT}
          />
          <ContextValidatorEditor
            value={advisory}
            onChange={setAdvisory}
            libraryProjectName={PROJECT}
          />
        </Panel>
      );
    };
    return <AuthorityHarness />;
  },
};

export const CodexImplementer: Story = {
  render: () => {
    const CodexHarness = () => {
      const [value, setValue] = useState<AgentAssignment>({
        ...IMPLEMENTER,
        agent: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
      });
      return (
        <Panel>
          <ImplementerEditor
            value={value}
            onChange={setValue}
            libraryProjectName={PROJECT}
          />
        </Panel>
      );
    };
    return <CodexHarness />;
  },
};

/** A use-site focus the composer would refuse, refused where it is authored. */
export const FocusRefusal: Story = {
  render: () => {
    const FocusHarness = () => {
      const [value, setValue] = useState<AgentAssignment>({
        ...IMPLEMENTER,
        focus: "follow the ```ts sample exactly",
      });
      return (
        <Panel>
          <ImplementerEditor
            value={value}
            onChange={setValue}
            libraryProjectName={PROJECT}
          />
        </Panel>
      );
    };
    return <FocusHarness />;
  },
};
