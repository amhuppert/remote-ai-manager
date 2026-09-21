import { z } from "zod";
import {
  recordServerBaseUrl,
  _resetServerBaseUrlForTesting,
} from "@/lib/agent-gateway/server-url";
import type { ConversationBackendFactory } from "../conversation";
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
  const factory: ConversationBackendFactory =
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
  return {
    factory,
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
      if (input.backend === "codex")
        return String(threadRequest?.developerInstructions ?? "");
      const systemPrompt = claude.lastOptions?.systemPrompt;
      if (typeof systemPrompt === "string") return systemPrompt;
      return systemPrompt && "append" in systemPrompt
        ? (systemPrompt.append ?? "")
        : "";
    },
    get userPrompt(): string {
      return input.backend === "claude"
        ? (claude.lastPromptText ?? "")
        : codex.lastPrompt;
    },
    close() {
      if (input.backend === "claude") _setSdkQueryForTesting(null);
      _resetServerBaseUrlForTesting();
    },
  };
}
