import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import SessionsFilterPopover from "./SessionsFilterPopover";
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
    derivedStatus: "running",
    promptCount: 2,
    derivedLastActivityAt: "2026-01-02T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...o,
  };
}

const sessions: SessionListItem[] = [
  makeSession({
    sessionName: "a",
    branchName: "csm/a",
    derivedStatus: "running",
  }),
  makeSession({
    sessionName: "b",
    branchName: "csm/b",
    derivedStatus: "idle",
    targetBranch: "develop",
  }),
];

const meta: Meta<typeof SessionsFilterPopover> = {
  title: "Project Cockpit/SessionsFilterPopover",
  component: SessionsFilterPopover,
};
export default meta;

type Story = StoryObj<typeof SessionsFilterPopover>;

export const Default: Story = {
  render: function Demo() {
    const [tokens, setTokens] = useState<FilterToken[]>([]);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <SessionsFilterPopover
          tokens={tokens}
          onTokensChange={setTokens}
          sessions={sessions}
        />
        <div
          style={{
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          tokens: {tokens.map((t) => `${t.key}:${t.value}`).join(", ") || "—"}
        </div>
      </div>
    );
  },
};
