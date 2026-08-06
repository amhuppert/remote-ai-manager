import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent } from "storybook/test";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import type { GlobalConfig, RawGlobalConfig } from "@/lib/config/schemas";
import ConfigPage from "./ConfigPage";

const ignorePatterns = [
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".cache",
  ".turbo",
  ".venv",
];

const defaultConfig: GlobalConfig = {
  baseDir: "/home/user/projects",
  defaultAgentBackend: "claude",
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      fastMode: false,
      model: "gpt-5.4",
      reasoningEffort: "high",
      timeoutMs: null,
    },
  },
  maxConcurrentQueries: 3,
  preMergeTimeoutMs: 300_000,
  ignorePatterns,
  tailscaleEnabled: true,
};

const minimalRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
};

const notificationConfig = {
  enabled: true,
  provider: "ntfy" as const,
  serverUrl: "https://ntfy.example.com",
  topic: "cc-notifications",
  triggers: {
    jobCompleted: true,
    waitingForInput: false,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: false,
    specApprovalRequested: true,
    specApprovalGranted: true,
    specPolicyAdmitted: true,
    planRepair: true,
  },
};

const fullyConfiguredRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  defaultAgentBackend: "codex",
  agentBackends: {
    claude: {
      model: "sonnet",
      reasoningEffort: "high",
      timeoutMs: 7_200_000,
    },
    codex: {
      fastMode: true,
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      timeoutMs: 5_400_000,
    },
  },
  branchPrefix: "feat",
  maxTurns: 50,
  maxConcurrentQueries: 5,
  preMergeTimeoutMs: 600_000,
  idleQuerySessionTtlMs: 1_800_000,
  tailscaleEnabled: false,
  pushNotification: notificationConfig,
  workflowDefaults: {
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "task",
          agent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true },
        },
      ],
    },
  },
};

const fullyConfiguredConfig: GlobalConfig = {
  ...defaultConfig,
  defaultAgentBackend: "codex",
  agentBackends: {
    claude: {
      model: "sonnet",
      reasoningEffort: "high",
      timeoutMs: 7_200_000,
    },
    codex: {
      fastMode: true,
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      timeoutMs: 5_400_000,
    },
  },
  branchPrefix: "feat",
  maxTurns: 50,
  maxConcurrentQueries: 5,
  preMergeTimeoutMs: 600_000,
  idleQuerySessionTtlMs: 1_800_000,
  tailscaleEnabled: false,
  pushNotification: notificationConfig,
  workflowDefaults: {
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          strategy: "task",
          agent: {
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true },
        },
      ],
    },
    scriptValidator: { enabled: false },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    iterationPolicy: {
      maxIterations: 20,
      continuity: { enabled: true },
    },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      enabled: false,
      secondAgent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  },
  compaction: {
    backend: "claude",
    conversationModel: "sonnet",
    messageModel: "sonnet",
    effort: "medium",
    timeoutMs: 180_000,
  },
};

const haikuConfig: GlobalConfig = {
  ...defaultConfig,
  agentBackends: {
    ...defaultConfig.agentBackends,
    claude: {
      model: "haiku",
      timeoutMs: 3_600_000,
    },
  },
};

const haikuRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  agentBackends: { claude: { model: "haiku" } },
};

function mockFetch(config: GlobalConfig, raw: RawGlobalConfig) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/agent-backends")) {
      return Response.json({ backends: listBackendCatalogEntries() });
    }
    if (url.includes("/api/config")) {
      if (init?.method === "PUT") {
        return Response.json({ config, raw });
      }
      return Response.json({ config, raw });
    }
    if (url.includes("/api/notifications")) {
      return Response.json({ notifications: [], unreadCount: 0, total: 0 });
    }
    if (url.includes("/api/conversations/active")) {
      return Response.json({ conversations: [] });
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
}

function WithMockData({
  config,
  raw,
  children,
}: {
  config: GlobalConfig;
  raw: RawGlobalConfig;
  children: React.ReactNode;
}) {
  const cleanup = mockFetch(config, raw);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  return (
    <QueryClientProvider client={createQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const meta = {
  title: "Config/ConfigPage",
  component: ConfigPage,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/config" },
    },
  },
} satisfies Meta<typeof ConfigPage>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openAgentBackends(
  canvas: Parameters<NonNullable<Story["play"]>>[0]["canvas"],
) {
  await userEvent.click(
    await canvas.findByRole("tab", { name: "Agent backends" }),
  );
  await canvas.findByText("Claude model");
}

export const Default = {
  decorators: [
    (Story) => (
      <WithMockData config={defaultConfig} raw={minimalRaw}>
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;

export const FullyConfigured = {
  decorators: [
    (Story) => (
      <WithMockData config={fullyConfiguredConfig} raw={fullyConfiguredRaw}>
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;

export const AgentBackends = {
  decorators: [
    (Story) => (
      <WithMockData config={fullyConfiguredConfig} raw={fullyConfiguredRaw}>
        <Story />
      </WithMockData>
    ),
  ],
  play: async ({ canvas }) => openAgentBackends(canvas),
} satisfies Story;

export const AgentBackendsMobile = {
  decorators: [
    (Story) => (
      <WithMockData config={fullyConfiguredConfig} raw={fullyConfiguredRaw}>
        <Story />
      </WithMockData>
    ),
  ],
  parameters: {
    viewport: {
      defaultViewport: "configMobile",
      viewports: {
        configMobile: {
          name: "390 × 844",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
  play: async ({ canvas }) => openAgentBackends(canvas),
} satisfies Story;

export const ClaudeHaikuNoEffort = {
  decorators: [
    (Story) => (
      <WithMockData config={haikuConfig} raw={haikuRaw}>
        <Story />
      </WithMockData>
    ),
  ],
  play: async ({ canvas }) => openAgentBackends(canvas),
} satisfies Story;
