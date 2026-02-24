import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ConversationMetrics } from "@/types";
import MetricsPanel from "./MetricsPanel";

const fullMetrics: ConversationMetrics = {
  inputTokens: 85200,
  outputTokens: 12300,
  cacheReadInputTokens: 5000,
  cacheCreationInputTokens: 2000,
  contextWindow: 200000,
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 85200,
      outputTokens: 12300,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 2000,
      costUSD: 0.45,
      contextWindow: 200000,
      maxOutputTokens: 16384,
    },
  },
  durationMs: 135000,
  durationApiMs: 98000,
  numTurns: 12,
  totalCostUsd: 0.45,
  model: "claude-sonnet-4-6",
  claudeCodeVersion: "1.0.25",
  tools: ["Read", "Write", "Bash", "Grep", "Glob"],
  mcpServers: [
    { name: "next-devtools", status: "connected" },
    { name: "chrome-devtools", status: "disconnected" },
  ],
  compactionCount: 2,
  lastCompactionPreTokens: 190000,
  compactions: [
    { trigger: "auto", preTokens: 180000, timestamp: "2024-06-15T10:30:00Z" },
    {
      trigger: "manual",
      preTokens: 190000,
      timestamp: "2024-06-15T11:00:00Z",
    },
  ],
  stopReason: "end_turn",
  errorSubtype: null,
  permissionDenials: null,
};

const partialMetrics: ConversationMetrics = {
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  contextWindow: null,
  modelUsage: null,
  durationMs: null,
  durationApiMs: null,
  numTurns: null,
  totalCostUsd: null,
  model: "claude-sonnet-4-6",
  claudeCodeVersion: "1.0.25",
  tools: ["Read", "Write", "Bash"],
  mcpServers: [{ name: "next-devtools", status: "connected" }],
  compactionCount: 0,
  lastCompactionPreTokens: null,
  compactions: [],
  stopReason: null,
  errorSubtype: null,
  permissionDenials: null,
};

const errorMetrics: ConversationMetrics = {
  inputTokens: 200000,
  outputTokens: 40000,
  cacheReadInputTokens: 10000,
  cacheCreationInputTokens: 5000,
  contextWindow: 200000,
  modelUsage: {},
  durationMs: 300000,
  durationApiMs: 250000,
  numTurns: 50,
  totalCostUsd: 1.25,
  model: "claude-sonnet-4-6",
  claudeCodeVersion: "1.0.25",
  tools: ["Read", "Write", "Bash"],
  mcpServers: [],
  compactionCount: 3,
  lastCompactionPreTokens: 195000,
  compactions: [
    { trigger: "auto", preTokens: 180000, timestamp: "2024-06-15T10:00:00Z" },
    { trigger: "auto", preTokens: 190000, timestamp: "2024-06-15T10:30:00Z" },
    { trigger: "auto", preTokens: 195000, timestamp: "2024-06-15T11:00:00Z" },
  ],
  stopReason: null,
  errorSubtype: "error_max_turns",
  permissionDenials: ["Bash", "Write"],
};

const multiModelMetrics: ConversationMetrics = {
  ...fullMetrics,
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 60000,
      outputTokens: 8000,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 1000,
      costUSD: 0.3,
      contextWindow: 200000,
      maxOutputTokens: 16384,
    },
    "claude-haiku-4-5": {
      inputTokens: 25200,
      outputTokens: 4300,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 1000,
      costUSD: 0.15,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    },
  },
};

const meta: Meta<typeof MetricsPanel> = {
  title: "Session/MetricsPanel",
  component: MetricsPanel,
  parameters: {
    layout: "padded",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 900 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof MetricsPanel>;

export const FullMetrics: Story = {
  args: { metrics: fullMetrics },
};

export const NullMetrics: Story = {
  args: { metrics: null },
};

export const PartialMetrics: Story = {
  args: { metrics: partialMetrics },
};

export const ErrorState: Story = {
  args: { metrics: errorMetrics },
};

export const MultiModel: Story = {
  args: { metrics: multiModelMetrics },
};
