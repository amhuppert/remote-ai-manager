import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  WorkflowCollaborationConfig,
} from "@/lib/workflows/schemas";
import {
  CircuitBreakerEditor,
  CollaborationEditor,
  ContextValidatorEditor,
  ImplementerEditor,
  IterationPolicyEditor,
} from "./FieldEditors";

const IMPLEMENTER: GraphWorkflowAgentConfig = {
  backend: "claude",
  model: "opus",
  reasoningEffort: "high",
};

const VALIDATOR: GraphWorkflowAgentValidatorConfig = {
  type: "claude",
  enabled: true,
  continuity: { enabled: true },
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
};

const ITERATION: GraphWorkflowIterationPolicy = {
  maxIterations: 20,
  continuity: { enabled: true },
};

const CIRCUIT_BREAKER: GraphWorkflowCircuitBreakerPolicy = {
  consecutiveFailureThreshold: 3,
};

const COLLABORATION: WorkflowCollaborationConfig = {
  secondAgent: {
    backend: "claude",
    model: "sonnet",
    reasoningEffort: "medium",
  },
  negotiationRounds: 3,
  autonomousResolutionThreshold: "minor",
};

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ width: 340, padding: 16, background: "var(--bg-surface)" }}
      className="flex flex-col gap-lg"
    >
      {children}
    </div>
  );
}

// Standalone harness so each editor is interactive in the story canvas; the
// editors are pure value+onChange, so local state is the only wiring needed.
function AllEditors({ readOnly }: { readOnly?: boolean }) {
  const [implementer, setImplementer] =
    useState<GraphWorkflowAgentConfig>(IMPLEMENTER);
  const [validator, setValidator] =
    useState<GraphWorkflowAgentValidatorConfig>(VALIDATOR);
  const [iteration, setIteration] =
    useState<GraphWorkflowIterationPolicy>(ITERATION);
  const [circuitBreaker, setCircuitBreaker] =
    useState<GraphWorkflowCircuitBreakerPolicy>(CIRCUIT_BREAKER);
  const [collaboration, setCollaboration] =
    useState<WorkflowCollaborationConfig>(COLLABORATION);

  return (
    <Panel>
      <ImplementerEditor
        value={implementer}
        onChange={setImplementer}
        readOnly={readOnly}
      />
      <ContextValidatorEditor
        value={validator}
        onChange={setValidator}
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

export const CodexImplementer: Story = {
  render: () => {
    const CodexHarness = () => {
      const [value, setValue] = useState<GraphWorkflowAgentConfig>({
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      });
      return (
        <Panel>
          <ImplementerEditor value={value} onChange={setValue} />
        </Panel>
      );
    };
    return <CodexHarness />;
  },
};
