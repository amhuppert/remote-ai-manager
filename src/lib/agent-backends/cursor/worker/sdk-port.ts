import type {
  AgentOptions,
  McpServerConfig,
  ModelSelection,
  SettingSource,
} from "@cursor/sdk";
import type { BackendModelSelection } from "../../schemas";
import type {
  CursorWorkerAgent,
  CursorWorkerAttachOptions,
  CursorWorkerMcpServer,
  CursorWorkerRun,
  CursorWorkerRunResult,
  CursorWorkerSdk,
  CursorWorkerSendMessage,
  CursorWorkerSendOptions,
} from "./entry";
import { createLogger } from "@/lib/logging";

const logger = createLogger("cursor-worker");

/**
 * The real `@cursor/sdk` behind the worker's port (spec D2, D11, D18).
 *
 * The SDK is imported dynamically, so a worker that never authenticates never
 * pays its load cost and a load failure is a typed preflight outcome rather
 * than a crash at module evaluation. Type-only imports are static: they cost
 * nothing at runtime and keep every option shape checked against the real SDK.
 *
 * This module is the ONLY place the SDK is constructed. Everything the worker
 * decides — policy, bounds, event forwarding, teardown — lives in `entry.ts`
 * against the port, which is what makes those decisions testable in-process.
 */

const SETTING_SOURCES: readonly SettingSource[] = [
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
  "all",
];

export function toCursorModelSelection(
  selection: BackendModelSelection,
): ModelSelection {
  return {
    id: selection.modelId,
    params: Object.entries(selection.parameters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => ({ id, value })),
  };
}

function isSettingSource(value: string): value is SettingSource {
  return SETTING_SOURCES.some((source) => source === value);
}

function toMcpServerConfig(
  servers: Record<string, CursorWorkerMcpServer>,
): Record<string, McpServerConfig> {
  const mapped: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(servers)) {
    mapped[name] = {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    };
  }
  return mapped;
}

async function loadSdkModule(): Promise<typeof import("@cursor/sdk")> {
  return import("@cursor/sdk");
}

type SdkModule = Awaited<ReturnType<typeof loadSdkModule>>;
type SdkAgent = Awaited<ReturnType<SdkModule["Agent"]["create"]>>;
type SdkRun = Awaited<ReturnType<SdkAgent["send"]>>;

interface ResumeRecoveryDeps<T> {
  resume(): Promise<T>;
  listRuns(cursor?: string): Promise<{
    items: readonly { id: string; status: import("@cursor/sdk").RunStatus }[];
    nextCursor?: string;
  }>;
  cancelRun(id: string): Promise<void>;
}

/** Only the worker owning this conversation may cancel an abandoned local run. */
export async function resumeWithAbandonedRunRecovery<T>(
  deps: ResumeRecoveryDeps<T>,
  allowed: boolean,
): Promise<T> {
  if (!allowed) return deps.resume();
  let cursor: string | undefined;
  do {
    const page = await deps.listRuns(cursor);
    const active = page.items.find((run) => run.status === "running");
    if (active) {
      await deps.cancelRun(active.id);
      logger.info("cursor-worker.abandoned_run_cancelled", {
        runId: active.id,
      });
      break;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return deps.resume();
}

function toAgentOptions(
  sdk: SdkModule,
  options: CursorWorkerAttachOptions,
): AgentOptions {
  return {
    model: toCursorModelSelection(options.modelSelection),
    apiKey: options.apiKey,
    disallowedTools: [...options.disallowedTools],
    mcpServers: toMcpServerConfig(options.mcpServers),
    agents: options.agents,
    local: {
      cwd: options.cwd,
      // The caller-owned store: agent rows, run events, and checkpoints land
      // under a Command Center state path instead of the SDK's default root
      // under the user's home, so nothing this conversation writes escapes
      // Command Center's ownership.
      store: new sdk.JsonlLocalAgentStore(options.storePath),
      settingSources: options.settingSources.filter(isSettingSource),
      sandboxOptions: { enabled: options.sandboxEnabled },
      autoReview: options.autoReview,
      enableAgentRetries: options.enableAgentRetries,
    },
  };
}

function toRunResult(
  result: Awaited<ReturnType<SdkRun["wait"]>>,
): CursorWorkerRunResult {
  return {
    status: result.status,
    ...(result.error !== undefined
      ? {
          error: {
            message: result.error.message,
            ...(result.error.code !== undefined
              ? { code: result.error.code }
              : {}),
          },
        }
      : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

function wrapRun(run: SdkRun): CursorWorkerRun {
  return {
    stream: () => run.stream(),
    wait: async () => toRunResult(await run.wait()),
    cancel: () => run.cancel(),
  };
}

function wrapAgent(agent: SdkAgent): CursorWorkerAgent {
  return {
    agentId: agent.agentId,
    async send(
      message: CursorWorkerSendMessage,
      options: CursorWorkerSendOptions,
    ) {
      const run = await agent.send(
        {
          text: message.text,
          ...(message.images.length > 0 ? { images: [...message.images] } : {}),
        },
        {
          model: toCursorModelSelection(options.modelSelection),
          mcpServers: toMcpServerConfig(options.mcpServers),
          ...(options.forceExpirePersistedRun
            ? { local: { force: true } }
            : {}),
        },
      );
      return wrapRun(run);
    },
    // Async disposal rather than `close()`: teardown must be awaitable, since
    // the parent's close only resolves once disposal has actually finished.
    dispose: () => agent[Symbol.asyncDispose](),
  };
}

export async function loadCursorWorkerSdk(): Promise<CursorWorkerSdk> {
  const sdk = await loadSdkModule();
  return {
    async verifyCredential(apiKey: string) {
      await sdk.Cursor.me({ apiKey });
    },
    async create(options) {
      return wrapAgent(await sdk.Agent.create(toAgentOptions(sdk, options)));
    },
    async resume(ref, options) {
      const agentOptions = toAgentOptions(sdk, options);
      const local = {
        runtime: "local" as const,
        cwd: options.cwd,
        store: agentOptions.local?.store,
      };
      return wrapAgent(
        await resumeWithAbandonedRunRecovery(
          {
            resume: () => sdk.Agent.resume(ref, agentOptions),
            listRuns: (cursor) => sdk.Agent.listRuns(ref, { ...local, cursor }),
            cancelRun: (id) => sdk.Agent.cancelRun(id, local),
          },
          options.recoverAbandonedRun === true,
        ),
      );
    },
  };
}
