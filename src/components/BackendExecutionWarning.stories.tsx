import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import {
  AgentRuntimeFields,
  agentConfigForBackend,
} from "./workflow-config/AssignmentEditor";
import BackendExecutionWarning from "./BackendExecutionWarning";

function Canvas({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
    return queryClient;
  });
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-md rounded-lg border border-solid border-border-default bg-bg-surface p-lg">
        {children}
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Components/BackendExecutionWarning",
  component: BackendExecutionWarning,
  args: { backend: "cursor" },
  decorators: [
    (Story) => (
      <Canvas>
        <Story />
      </Canvas>
    ),
  ],
} satisfies Meta<typeof BackendExecutionWarning>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Cursor = {} satisfies Story;

export const WorkflowAssignment = {
  render: function WorkflowAssignment() {
    const [value, setValue] = useState(() => agentConfigForBackend("cursor"));
    return (
      <>
        <h3 className="m-0 text-sm font-medium text-text-primary">
          Workflow validator
        </h3>
        <AgentRuntimeFields value={value} onChange={setValue} />
      </>
    );
  },
} satisfies Story;
