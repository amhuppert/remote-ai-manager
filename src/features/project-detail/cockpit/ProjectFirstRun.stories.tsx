import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import ProjectFirstRun from "./ProjectFirstRun";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import { withSeededQueryClient } from "./story-support";
import "./styles/cockpit.css";

const sessions: SessionListItem[] = [
  {
    sessionName: "implement-auth",
    worktreePath: "/tmp/wt/a",
    branchName: "csm/implement-auth",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-02T00:00:00Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "fast",
    tddEnabled: true,
    objective: null,
    derivedStatus: "idle",
    promptCount: 1,
    derivedLastActivityAt: "2026-01-02T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
  },
];

function Harness() {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <div style={{ height: 640, maxWidth: 1000, margin: "0 auto" }}>
      <ProjectFirstRun
        projectName="command-center"
        sessions={sessions}
        archivedCount={4}
        tokens={tokens}
        onTokensChange={setTokens}
        onRunCommand={fn()}
        selectedBackend={backend}
        onSelectedBackendChange={setBackend}
      />
    </div>
  );
}

const meta: Meta<typeof ProjectFirstRun> = {
  title: "Project Cockpit/ProjectFirstRun",
  component: ProjectFirstRun,
  decorators: [withSeededQueryClient([])],
};
export default meta;

type Story = StoryObj<typeof ProjectFirstRun>;

export const SingleColumn: Story = {
  render: () => <Harness />,
};
