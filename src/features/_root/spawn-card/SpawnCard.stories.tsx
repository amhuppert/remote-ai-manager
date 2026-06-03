import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import SpawnCard from "./SpawnCard";
import { validateProposal } from "@/lib/chat-spawning/proposal-validator";

const meta: Meta<typeof SpawnCard> = {
  title: "Spawn Card/SpawnCard",
  component: SpawnCard,
};
export default meta;

type Story = StoryObj<typeof SpawnCard>;

const single = validateProposal({
  sessions: [
    {
      name: "Add login form",
      branch: "feat/login",
      agent: "claude",
      mode: "fast",
      initialPrompt: "Implement the login form with email + password.",
    },
  ],
});

const multi = validateProposal({
  sessions: [
    {
      name: "Auth API",
      branch: "feat/auth-api",
      agent: "claude",
      mode: "focus",
    },
    {
      name: "Auth UI",
      branch: "feat/auth-ui",
      target: "develop",
      agent: "codex",
      mode: "fast",
    },
    {
      name: "Race the migration",
      branch: "feat/migration",
      agent: "dual",
      mode: "fast",
      initialPrompt: "Write the DB migration both ways and race them.",
    },
  ],
});

const invalid = validateProposal({
  sessions: [{ name: "broken", branch: "feat/x", agent: "gpt", mode: "fast" }],
});

/** Single proposed session — one row with name, branch → target, agent. */
export const SingleSession: Story = {
  args: {
    validation: single,
    projectName: "command-center",
    conversationId: "plc-1",
  },
};

/** Multi-session batch — the Create control reads "Create 3 sessions". */
export const MultiSession: Story = {
  args: {
    validation: multi,
    projectName: "command-center",
    conversationId: "plc-1",
  },
};

/** Invalid proposal — a non-actionable error state with no Create. */
export const Invalid: Story = {
  args: {
    validation: invalid,
    projectName: "command-center",
    conversationId: "plc-1",
  },
};
