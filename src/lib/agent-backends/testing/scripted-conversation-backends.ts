import { z } from "zod";
import {
  recordServerBaseUrl,
  _resetServerBaseUrlForTesting,
} from "@/lib/agent-gateway/server-url";
import type {
  ConversationBackendFactory,
  ConversationBackendTurnInput,
} from "../conversation";
import { claudeConversationBackendFactory } from "../claude/conversation-runtime";
import { _setSdkQueryForTesting } from "../claude/query-session";
import { CodexConversationRuntime } from "../codex/conversation-runtime";
import { createFakeClaudeSdkController } from "./fake-claude-sdk-port";
import { createFakeCodexProvider } from "./fake-codex-provider";

/** Real conversation adapters with only their final provider ports scripted. */
export function createScriptedConversationBackend(input: {
  backend: "claude" | "codex";
  responseText: string;
  sandboxUnavailable?: boolean;
}) {
  recordServerBaseUrl({
    CC_SERVER_URL: "http://cc-provider-fixture.test:4312",
  });
  const claude = createFakeClaudeSdkController({
    responseText: input.responseText,
  });
  const codex = createFakeCodexProvider({
    structuredOutput: JSON.parse(input.responseText),
  });
  let threadRequest: Record<string, unknown> | undefined;
  let codexThreadInstructions = "";
  const adapterFactory: ConversationBackendFactory =
    input.backend === "claude"
      ? {
          backend: "claude",
          validateModelSelection:
            claudeConversationBackendFactory.validateModelSelection,
          async createRuntime(createInput) {
            _setSdkQueryForTesting((args) => {
              if (input.sandboxUnavailable)
                throw new Error("sandbox dependencies are unavailable");
              return claude.createSdkQuery(args);
            });
            return claudeConversationBackendFactory.createRuntime(createInput);
          },
        }
      : {
          backend: "codex",
          validateModelSelection() {},
          async createRuntime(createInput) {
            return new CodexConversationRuntime(createInput, {
              ...codex.deps,
              createAppServer(options) {
                if (input.sandboxUnavailable)
                  throw new Error(
                    "sandbox setup failed: seatbelt sandbox is unavailable on this host",
                  );
                const provider = codex.deps.createAppServer(options);
                return {
                  ...provider,
                  async request(method, params) {
                    if (method !== "thread/start" && method !== "thread/resume")
                      return provider.request(method, params);
                    threadRequest = z
                      .record(z.string(), z.unknown())
                      .parse(params);
                    if (method === "thread/start")
                      codexThreadInstructions = String(
                        threadRequest.developerInstructions ?? "",
                      );
                    const response = z
                      .record(z.string(), z.unknown())
                      .parse(await provider.request(method, params));
                    if (threadRequest.sandbox !== "workspace-write")
                      return response;
                    const config = z
                      .looseObject({
                        sandbox_workspace_write: z.object({
                          writable_roots: z.array(z.string()),
                          exclude_tmpdir_env_var: z.boolean(),
                          exclude_slash_tmp: z.boolean(),
                        }),
                      })
                      .parse(threadRequest.config);
                    const sandbox = config.sandbox_workspace_write;
                    return {
                      ...response,
                      sandbox: {
                        type: "workspaceWrite",
                        writableRoots: sandbox.writable_roots,
                        excludeTmpdirEnvVar: sandbox.exclude_tmpdir_env_var,
                        excludeSlashTmp: sandbox.exclude_slash_tmp,
                      },
                    };
                  },
                };
              },
            });
          },
        };
  const turns: Array<{
    prompt: string;
    outputFormat: ConversationBackendTurnInput["outputFormat"];
  }> = [];
  const userPrompt = (): string =>
    input.backend === "claude"
      ? (claude.lastPromptText ?? "")
      : codex.lastPrompt;
  const factory: ConversationBackendFactory = {
    ...adapterFactory,
    async createRuntime(createInput) {
      const runtime = await adapterFactory.createRuntime(createInput);
      const sendTurn = runtime.sendTurn.bind(runtime);
      runtime.sendTurn = async (turnInput) => {
        const result = await sendTurn(turnInput);
        turns.push({
          prompt: userPrompt(),
          outputFormat: turnInput.outputFormat,
        });
        return result;
      };
      return runtime;
    },
  };
  return {
    factory,
    get turns(): ReadonlyArray<(typeof turns)[number]> {
      return turns;
    },
    get claudeOptions() {
      return claude.lastOptions;
    },
    get codexThreadRequest() {
      return threadRequest;
    },
    get codexConfig(): Record<string, unknown> {
      return z
        .record(z.string(), z.unknown())
        .parse(threadRequest?.config ?? {});
    },
    get privilegedInstructions(): string {
      if (input.backend === "codex") return codexThreadInstructions;
      const systemPrompt = claude.lastOptions?.systemPrompt;
      if (typeof systemPrompt === "string") return systemPrompt;
      return systemPrompt && "append" in systemPrompt
        ? (systemPrompt.append ?? "")
        : "";
    },
    get userPrompt(): string {
      return userPrompt();
    },
    close() {
      if (input.backend === "claude") _setSdkQueryForTesting(null);
      _resetServerBaseUrlForTesting();
    },
  };
}
