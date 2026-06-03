import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import SessionsPanel from "./SessionsPanel";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { FilterToken } from "../components/filter-tokens";
import "./styles/cockpit.css";

function makeSession(
  o: Partial<SessionListItem> &
    Pick<SessionListItem, "sessionName" | "branchName">,
): SessionListItem {
  return {
    worktreePath: `/tmp/wt/${o.sessionName}`,
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
    promptCount: 2,
    derivedLastActivityAt: "2026-01-02T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...o,
  };
}

const sessions: SessionListItem[] = [
  makeSession({
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    derivedStatus: "running",
  }),
  makeSession({
    sessionName: "fix-parser",
    branchName: "csm/fix-parser",
    targetBranch: "develop",
  }),
  makeSession({
    sessionName: "refactor-store",
    branchName: "csm/refactor-store",
    derivedStatus: "idle",
  }),
];

function Harness({ initialTokens = [] }: { initialTokens?: FilterToken[] }) {
  const [tokens, setTokens] = useState<FilterToken[]>(initialTokens);
  return (
    <div style={{ height: 560, width: 380, display: "flex" }}>
      <SessionsPanel
        projectName="command-center"
        sessions={sessions}
        tokens={tokens}
        onTokensChange={setTokens}
      />
    </div>
  );
}

const meta: Meta<typeof SessionsPanel> = {
  title: "Project Cockpit/SessionsPanel",
  component: SessionsPanel,
};
export default meta;

type Story = StoryObj<typeof SessionsPanel>;

export const Default: Story = {
  render: () => <Harness />,
};

/** Open the Filter popover and toggle a status — the chip appears below. */
export const SharedFilterState: Story = {
  render: () => (
    <Harness initialTokens={[{ cat: "status", key: "is", value: "running" }]} />
  ),
};

/** Use the search box (name/branch) to narrow the list. */
export const SearchAndEmpty: Story = {
  render: () => <Harness />,
};
