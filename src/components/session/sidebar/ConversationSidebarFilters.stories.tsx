import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import ConversationSidebarFilters from "./ConversationSidebarFilters";

function FiltersHarness() {
  const [project, setProject] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [workflows, setWorkflows] = useState(false);
  return (
    <div className="w-[340px] bg-bg-base p-md">
      <ConversationSidebarFilters
        projects={["command-center", "active-recall"]}
        project={project}
        onProjectChange={setProject}
        includeGraphWorkflows={workflows}
        onGraphWorkflowsChange={setWorkflows}
        includeArchived={archived}
        onArchivedChange={setArchived}
      />
    </div>
  );
}
const meta = {
  title: "Session/ConversationSidebarFilters",
  component: FiltersHarness,
} satisfies Meta<typeof FiltersHarness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
