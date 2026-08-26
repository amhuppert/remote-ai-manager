import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent } from "storybook/test";
import SpawnCard, { ValidSpawnCard } from "./SpawnCard";
import { validateProposal } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import {
  getStaticBackendModelCatalog,
  type BackendValueMap,
} from "@/lib/agent-backends/catalog";
import { loadGeneratedCursorModelCatalog } from "@/lib/agent-backends/cursor/model-catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import type { BackendModelCatalog } from "@/lib/agent-backends/schemas";
import { withSeededQueryClient } from "../cockpit/story-support";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

function projectModelOptions() {
  const catalogs: BackendValueMap<BackendModelCatalog> = {
    claude: getStaticBackendModelCatalog("claude"),
    codex: getStaticBackendModelCatalog("codex", BACKEND_DEFAULTS.codex),
    cursor: loadGeneratedCursorModelCatalog(),
  };
  return (["claude", "codex", "cursor"] as const).map((backend) => ({
    backend,
    models: [],
    defaultModelId: BACKEND_DEFAULTS[backend].modelId,
    source: "catalog" as const,
    modelCatalog: catalogs[backend],
    defaultSelection: BACKEND_DEFAULTS[backend],
    diagnostics: [],
  }));
}

const meta: Meta<typeof ValidSpawnCard> = {
  title: "Spawn Card/SpawnCard",
  component: ValidSpawnCard,
  decorators: [
    withSeededQueryClient([
      [
        backendCatalogKeys.projectModelOptions("command-center"),
        projectModelOptions(),
      ],
    ]),
  ],
};
export default meta;

type Story = StoryObj<typeof ValidSpawnCard>;

function asProposal(candidate: unknown): SpawnProposal {
  const validation = validateProposal(candidate);
  if (validation.kind !== "valid") throw new Error("expected a valid proposal");
  return validation.proposal;
}

const single = asProposal({
  sessions: [
    {
      name: "readme-polish",
      agent: "claude",
      mode: "normal",
      initialPrompt:
        "Review README.md for clarity and fix any typos or outdated setup instructions.",
    },
  ],
});

const multi = asProposal({
  sessions: [
    {
      name: "dep-audit",
      agent: "claude",
      mode: "normal",
      initialPrompt:
        "Audit dependencies for known vulnerabilities, flag anything unmaintained or out of date, and suggest a safe upgrade path for each one.",
    },
    {
      name: "auth-ui",
      target: "develop",
      agent: "codex",
      mode: "normal",
    },
    {
      name: "race-the-migration",
      agent: "dual",
      mode: "optimistic",
      initialPrompt: "Write the DB migration both ways and race them.",
    },
  ],
});

const longTitles = asProposal({
  sessions: [
    {
      name: "VOGUE-4982 Fix location table sorting",
      target: "main",
      agent: "claude",
      mode: "optimistic",
      initialPrompt:
        "Implement VOGUE-4982 end to end and visually verify the behavior.",
    },
  ],
});

const TARGET_OPTIONS = ["main", "develop", "feat/structured-json"];

/** Single proposed session — switch, name, auto-named branch, agent + mode. */
export const SingleSession: Story = {
  args: {
    proposal: single,
    projectName: "command-center",
    conversationId: "plc-1",
    spawnedStatuses: undefined,
    branchPrefix: "csm",
    targetOptions: TARGET_OPTIONS,
    backendDefaults: BACKEND_DEFAULTS,
  },
};

/** Multi-session batch — the Create control reads "Create 3 sessions". */
export const MultiSession: Story = {
  args: {
    proposal: multi,
    projectName: "command-center",
    conversationId: "plc-1",
    spawnedStatuses: undefined,
    branchPrefix: "csm",
    targetOptions: TARGET_OPTIONS,
    backendDefaults: BACKEND_DEFAULTS,
  },
};

/** Editable session names use the full row width instead of a fixed-width field. */
export const LongSessionTitle: Story = {
  args: {
    proposal: longTitles,
    projectName: "command-center",
    conversationId: "plc-1",
    spawnedStatuses: undefined,
    branchPrefix: "csm",
    targetOptions: TARGET_OPTIONS,
    backendDefaults: BACKEND_DEFAULTS,
  },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Edit" }));

    const input = canvas.getByRole("textbox", {
      name: "Session 1 name",
    });
    const header = input.parentElement;
    if (!header) throw new Error("session title header not rendered");

    await expect(input.getBoundingClientRect().right).toBeCloseTo(
      header.getBoundingClientRect().right,
      0,
    );
  },
};

/** Invalid proposal — a non-actionable error state with no Create. */
export const Invalid: StoryObj<typeof SpawnCard> = {
  render: (args) => <SpawnCard {...args} />,
  args: {
    validation: validateProposal({
      sessions: [{ name: "broken", agent: "gpt", mode: "normal" }],
    }),
    projectName: "command-center",
    conversationId: "plc-1",
    backendDefaults: BACKEND_DEFAULTS,
  },
};
