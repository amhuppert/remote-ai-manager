import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { RawGlobalConfig } from "@/lib/config/schemas";
import ConfigPage from "./ConfigPage";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const defaultConfig: GlobalConfig = {
  baseDir: "/home/user/projects",
  defaultModel: "opus",
  defaultAgentBackend: "claude",
  claudeTimeoutMs: 3_600_000,
  maxConcurrentQueries: 3,
  preMergeTimeoutMs: 300_000,
  ignorePatterns: [
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    ".cache",
    ".turbo",
    ".venv",
  ],
  tailscaleEnabled: true,
};

const minimalRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  defaultModel: "opus",
};

const fullyConfiguredRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  defaultModel: "sonnet",
  defaultAgentBackend: "codex",
  defaultEffort: "high",
  branchPrefix: "feat",
  claudeTimeoutMs: 7_200_000,
  maxTurns: 50,
  maxConcurrentQueries: 5,
  preMergeTimeoutMs: 600_000,
  idleQuerySessionTtlMs: 1_800_000,
  tailscaleEnabled: false,
  pushNotification: {
    enabled: true,
    provider: "ntfy",
    serverUrl: "https://ntfy.example.com",
    topic: "cc-notifications",
    triggers: {
      jobCompleted: true,
      waitingForInput: false,
      workflowCompleted: true,
      workflowHalted: true,
      conversationIdle: false,
    },
  },
  codex: {
    enabled: true,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
  },
  workflowDefaults: {
    contextValidator: {
      type: "codex",
      enabled: true,
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
      continuity: { enabled: true },
    },
  },
};

const fullyConfiguredConfig: GlobalConfig = {
  ...defaultConfig,
  ...fullyConfiguredRaw,
  pushNotification: {
    enabled: true,
    provider: "ntfy",
    serverUrl: "https://ntfy.example.com",
    topic: "cc-notifications",
    triggers: {
      jobCompleted: true,
      waitingForInput: false,
      workflowCompleted: true,
      workflowHalted: true,
      conversationIdle: false,
    },
  },
  codex: {
    enabled: true,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
  },
  workflowDefaults: {
    implementer: {
      backend: "claude",
      model: "opus",
      reasoningEffort: "medium",
    },
    contextValidator: {
      type: "codex",
      enabled: true,
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "medium",
      },
      continuity: { enabled: true },
    },
    scriptValidator: {
      enabled: false,
    },
    humanApprovalGate: {
      enabled: false,
    },
    iterationPolicy: {
      maxIterations: 20,
      continuity: { enabled: true },
    },
    circuitBreaker: {
      consecutiveFailureThreshold: 3,
    },
    mutability: {
      allowAgentTaskAdd: false,
    },
    collaboration: {
      secondAgent: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
  },
};

// ---------------------------------------------------------------------------
// Fetch mocking
// ---------------------------------------------------------------------------

function mockFetch(config: GlobalConfig, raw: RawGlobalConfig) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/config")) {
      if (init?.method === "PUT") {
        return Response.json({ config, raw });
      }
      return Response.json({ config, raw });
    }
    if (url.includes("/api/notifications")) {
      return Response.json({
        notifications: [],
        unreadCount: 0,
        totalCount: 0,
      });
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

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Config/ConfigPage",
  component: ConfigPage,
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/config" },
    },
  },
} satisfies Meta<typeof ConfigPage>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

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

const codexBackendConfig: GlobalConfig = {
  ...defaultConfig,
  defaultAgentBackend: "codex",
  codex: {
    enabled: true,
    model: "gpt-5.4",
    reasoningEffort: "high",
  },
};

const codexBackendRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  defaultAgentBackend: "codex",
  codex: {
    enabled: true,
    model: "gpt-5.4",
    reasoningEffort: "high",
  },
};

export const CodexBackend = {
  decorators: [
    (Story) => (
      <WithMockData config={codexBackendConfig} raw={codexBackendRaw}>
        <Story />
      </WithMockData>
    ),
  ],
} satisfies Story;
