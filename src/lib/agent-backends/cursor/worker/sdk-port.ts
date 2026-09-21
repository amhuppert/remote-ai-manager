import type { AgentOptions, ModelSelection, SettingSource } from "@cursor/sdk";
import type { BackendModelSelection } from "../../schemas";
import type {
  CursorWorkerAgent,
  CursorWorkerAttachOptions,
  CursorWorkerRun,
  CursorWorkerRunResult,
  CursorWorkerSdk,
  CursorWorkerSendMessage,
  CursorWorkerSendOptions,
} from "./entry";
import { createLogger } from "@/lib/logging";
import { z } from "zod";
import { inTurnQuestionBatchSchema } from "@/lib/conversations/in-turn-question-schemas";

import { openCursorMcpBridge, type CursorMcpBridge } from "./mcp-bridge";

const logger = createLogger("cursor-worker");
const questionInputSchema = z
  .record(z.string(), z.json())
  .parse(JSON.parse(JSON.stringify(z.toJSONSchema(inTurnQuestionBatchSchema))));

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
  bridge: CursorMcpBridge,
): AgentOptions {
  return {
    model: toCursorModelSelection(options.modelSelection),
    apiKey: options.apiKey,
    disallowedTools: [...options.disallowedTools],
    ...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
    mcpServers: bridge.servers,
    agents: options.agents,
    local: {
      cwd: options.cwd,
      // The caller-owned store: agent rows, run events, and checkpoints land
      // under a Command Center state path instead of the SDK's default root
      // under the user's home. SDK auxiliary state has separate storage rules.
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
    ...(run.steer ? { steer: (text: string) => run.steer!(text) } : {}),
    stream: () => run.stream(),
    wait: async () => toRunResult(await run.wait()),
    cancel: () => run.cancel(),
  };
}

export function wrapCursorSdkAgent(
  agent: Pick<
    SdkAgent,
    "agentId" | "send" | "getUsage" | typeof Symbol.asyncDispose
  >,
  initialBridge: CursorMcpBridge,
  options: Pick<CursorWorkerAttachOptions, "mcpServers">,
): CursorWorkerAgent {
  let bridge = initialBridge;
  let configKey: string | null = JSON.stringify(options.mcpServers);
  return {
    agentId: agent.agentId,
    async send(
      message: CursorWorkerSendMessage,
      options: CursorWorkerSendOptions,
    ) {
      const nextKey = JSON.stringify(options.mcpServers);
      if (nextKey !== configKey) {
        configKey = null;
        await bridge.close();
        bridge = await openCursorMcpBridge(options.mcpServers);
        configKey = nextKey;
      }
      let text = message.text;
      if (bridge.startupFailures.length > 0) {
        configKey = null;
        text += `\n\nSome configured MCP servers are unavailable for this turn. Continue with available tools and report any resulting limitation:\n${bridge.startupFailures.join("\n")}`;
        logger.warn("cursor-worker.mcp_unavailable", {
          agentId: agent.agentId,
          failedServerCount: bridge.startupFailures.length,
          availableServerCount: Object.keys(bridge.servers).length,
        });
      }
      const run = await agent.send(
        {
          text,
          ...(message.images.length > 0 ? { images: [...message.images] } : {}),
        },
        {
          model: toCursorModelSelection(options.modelSelection),
          onDelta: ({ update }) => {
            if (update.type === "tool-call-delta")
              options.onTaskUpdate?.(update);
          },
          mcpServers: bridge.servers,
          local: {
            ...(options.forceExpirePersistedRun ? { force: true } : {}),
            customTools: options.onQuestion
              ? {
                  cc_question: {
                    description:
                      "Ask the user one to three questions and wait for their reply in this turn. The request expires after five minutes. Concurrent questions share one panel. On cancellation or expiry, continue with best judgment. Use cctl ask for asynchronous next-turn questions.",
                    inputSchema: questionInputSchema,
                    execute: async (args, context) => {
                      const parsed = inTurnQuestionBatchSchema.safeParse(args);
                      if (!parsed.success)
                        return {
                          status: "unavailable",
                          message:
                            "Provide one to three questions with question text and options",
                        };
                      return options.onQuestion!(
                        parsed.data.questions,
                        context.toolCallId,
                      );
                    },
                  },
                }
              : {},
          },
        },
      );
      return wrapRun(run);
    },
    // The cloud usage endpoint keyed by this agent's id; the SDK's own
    // `AgentUsage` shape is the port's shape, so nothing is reinterpreted here.
    getUsage: () => agent.getUsage(),
    // Async disposal rather than `close()`: teardown must be awaitable, since
    // the parent's close only resolves once disposal has actually finished.
    async dispose() {
      try {
        await agent[Symbol.asyncDispose]();
      } finally {
        await bridge.close();
      }
    },
  };
}

export async function loadCursorWorkerSdk(): Promise<CursorWorkerSdk> {
  const sdk = await loadSdkModule();
  return {
    async verifyCredential(apiKey: string) {
      await sdk.Cursor.me({ apiKey });
    },
    async create(options) {
      const bridge = await openCursorMcpBridge(options.mcpServers);
      try {
        return wrapCursorSdkAgent(
          await sdk.Agent.create(toAgentOptions(sdk, options, bridge)),
          bridge,
          options,
        );
      } catch (error) {
        await bridge.close();
        throw error;
      }
    },
    async resume(ref, options) {
      const bridge = await openCursorMcpBridge(options.mcpServers);
      const agentOptions = toAgentOptions(sdk, options, bridge);
      const local = {
        runtime: "local" as const,
        cwd: options.cwd,
        store: agentOptions.local?.store,
      };
      try {
        return wrapCursorSdkAgent(
          await resumeWithAbandonedRunRecovery(
            {
              resume: () => sdk.Agent.resume(ref, agentOptions),
              listRuns: (cursor) =>
                sdk.Agent.listRuns(ref, { ...local, cursor }),
              cancelRun: (id) => sdk.Agent.cancelRun(id, local),
            },
            options.recoverAbandonedRun === true,
          ),
          bridge,
          options,
        );
      } catch (error) {
        await bridge.close();
        throw error;
      }
    },
  };
}
