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
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      timeoutMs: 3_600_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { reasoning: "high", fast: "false" },
      },
      timeoutMs: null,
    },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  },
  maxConcurrentQueries: 3,
  preMergeTimeoutMs: 300_000,
  validation: {
    concurrencyLimit: 8,
    defaultTimeoutMs: 600_000,
  },
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
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "high" },
      },
      timeoutMs: 7_200_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4-mini",
        parameters: { reasoning: "high", fast: "true" },
      },
      timeoutMs: 5_400_000,
    },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  },
  branchPrefix: "feat",
  maxTurns: 50,
  maxConcurrentQueries: 5,
  preMergeTimeoutMs: 600_000,
  idleQuerySessionTtlMs: 1_800_000,
  validation: {
    concurrencyLimit: 6,
    defaultTimeoutMs: 900_000,
  },
  tailscaleEnabled: false,
  pushNotification: notificationConfig,
  workflowDefaults: {
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          authority: "blocking",
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
          },
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
      modelSelection: {
        modelId: "sonnet",
        parameters: { effort: "high" },
      },
      timeoutMs: 7_200_000,
    },
    codex: {
      modelSelection: {
        modelId: "gpt-5.4-mini",
        parameters: { reasoning: "high", fast: "true" },
      },
      timeoutMs: 5_400_000,
    },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  },
  branchPrefix: "feat",
  maxTurns: 50,
  maxConcurrentQueries: 5,
  preMergeTimeoutMs: 600_000,
  idleQuerySessionTtlMs: 1_800_000,
  validation: {
    concurrencyLimit: 6,
    defaultTimeoutMs: 900_000,
  },
  tailscaleEnabled: false,
  pushNotification: notificationConfig,
  workflowDefaults: {
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      agent: {
        backend: "claude",
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "medium" },
        },
      },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          authority: "blocking",
          agent: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "medium", fast: "false" },
            },
          },
        },
      ],
    },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    iterationPolicy: {
      maxIterations: 20,
    },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      enabled: false,
      secondAgent: {
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      },
      negotiationRounds: 3,
      autonomousResolutionThreshold: "minor",
    },
    agentValidation: {
      implementer: { mode: "all", except: [] },
      contextValidator: { mode: "only", commands: [] },
    },
    laneMergeValidation: {
      strategy: "final-only",
      commands: { mode: "project" },
    },
    memory: {
      implementer: { read: "ambient", contribute: "on" },
      validator: { read: "off", contribute: "off" },
    },
  },
  compaction: {
    backend: "claude",
    conversationModelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
    messageModelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
    timeoutMs: 180_000,
  },
};

const haikuConfig: GlobalConfig = {
  ...defaultConfig,
  agentBackends: {
    ...defaultConfig.agentBackends,
    claude: {
      modelSelection: { modelId: "haiku", parameters: {} },
      timeoutMs: 3_600_000,
    },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  },
};

const haikuRaw: RawGlobalConfig = {
  baseDir: "/home/user/projects",
  agentBackends: {
    claude: { modelSelection: { modelId: "haiku", parameters: {} } },
    cursor: {
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
      timeoutMs: null,
    },
  },
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

async function openLimits(
  canvas: Parameters<NonNullable<Story["play"]>>[0]["canvas"],
) {
  await userEvent.click(
    await canvas.findByRole("tab", { name: "Limits & timeouts" }),
  );
  await canvas.findByRole("textbox", {
    name: "Validation capacity",
  });
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

export const LimitsAndTimeouts = {
  decorators: [
    (Story) => (
      <WithMockData config={fullyConfiguredConfig} raw={fullyConfiguredRaw}>
        <Story />
      </WithMockData>
    ),
  ],
  play: async ({ canvas }) => openLimits(canvas),
} satisfies Story;

export const LimitsAndTimeoutsMobile = {
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
  play: async ({ canvas }) => openLimits(canvas),
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

export const CheckpointCompaction = {
  decorators: Default.decorators,
  play: async ({ canvas }) => {
    await userEvent.click(
      await canvas.findByRole("tab", { name: "Compaction" }),
    );
  },
} satisfies Story;

const checkpointCodexConfig: GlobalConfig = {
  ...defaultConfig,
  compaction: {
    backend: "codex",
    conversationModelSelection: {
      modelId: "gpt-5.4-mini",
      parameters: { reasoning: "low", fast: "false" },
    },
    messageModelSelection: {
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    },
  },
};

export const CheckpointCompactionCodex = {
  decorators: [
    (Story) => (
      <WithMockData
        config={checkpointCodexConfig}
        raw={{ ...minimalRaw, compaction: checkpointCodexConfig.compaction }}
      >
        <Story />
      </WithMockData>
    ),
  ],
  play: CheckpointCompaction.play,
} satisfies Story;

const cursorAuxiliaryConfig: GlobalConfig = {
  ...defaultConfig,
  conversationNaming: {
    enabled: true,
    backend: "cursor",
    modelSelection: defaultConfig.agentBackends.cursor.modelSelection,
  },
  compaction: {
    backend: "cursor",
    conversationModelSelection:
      defaultConfig.agentBackends.cursor.modelSelection,
    messageModelSelection: defaultConfig.agentBackends.cursor.modelSelection,
  },
};

export const CursorNaming = {
  decorators: [
    (Story) => (
      <WithMockData
        config={cursorAuxiliaryConfig}
        raw={{
          ...minimalRaw,
          conversationNaming: cursorAuxiliaryConfig.conversationNaming,
          compaction: cursorAuxiliaryConfig.compaction,
        }}
      >
        <Story />
      </WithMockData>
    ),
  ],
  play: async ({ canvas }) => {
    await userEvent.click(await canvas.findByRole("tab", { name: "Naming" }));
  },
} satisfies Story;

export const CursorCompaction = {
  decorators: CursorNaming.decorators,
  play: CheckpointCompaction.play,
} satisfies Story;
