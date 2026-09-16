import { z } from "zod";
import { CodexConversationRuntime } from "../codex/conversation-runtime";
import type {
  ConversationBackendCreateInput,
  ConversationBackendRuntime,
} from "../conversation";
import { createFakeCodexProvider } from "./fake-codex-provider";

const workspaceWriteSchema = z.object({
  writable_roots: z.array(z.string()),
  exclude_tmpdir_env_var: z.boolean(),
  exclude_slash_tmp: z.boolean(),
  network_access: z.boolean(),
});

/** Exercises the real conversation policy translation at its native port. */
export function createCodexWriteEnvelopeFixture() {
  let launch: { cwd: string; env: Record<string, string> } | undefined;
  const requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];

  return {
    createRuntime(
      input: ConversationBackendCreateInput,
    ): ConversationBackendRuntime {
      const provider = createFakeCodexProvider();
      return new CodexConversationRuntime(input, {
        ...provider.deps,
        buildChildEnv: () => ({
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
        }),
        createAppServer(options) {
          launch = { cwd: options.cwd, env: options.env };
          const client = provider.deps.createAppServer(options);
          return {
            ...client,
            async request(method, params) {
              const fields = z.record(z.string(), z.unknown()).parse(params);
              requests.push({ method, params: fields });
              const response = await client.request(method, params);
              if (method !== "thread/start" && method !== "thread/resume")
                return response;
              // Report the requested effective policy so runtime validation
              // executes against the complete native response shape.
              if (fields.sandbox !== "workspace-write") return response;
              const config = z
                .record(z.string(), z.unknown())
                .parse(fields.config);
              const sandbox = workspaceWriteSchema.parse(
                config.sandbox_workspace_write,
              );
              return {
                ...z.record(z.string(), z.unknown()).parse(response),
                sandbox: {
                  type: "workspaceWrite",
                  writableRoots: sandbox.writable_roots,
                  excludeTmpdirEnvVar: sandbox.exclude_tmpdir_env_var,
                  excludeSlashTmp: sandbox.exclude_slash_tmp,
                  networkAccess: sandbox.network_access,
                },
              };
            },
          };
        },
      });
    },
    readThreadPolicy() {
      const request = requests.find(({ method }) => method === "thread/start");
      if (!request) throw new Error("Codex thread/start was not dispatched");
      const config = z
        .record(z.string(), z.unknown())
        .parse(request.params.config);
      const workspaceWrite =
        config.sandbox_workspace_write === undefined
          ? undefined
          : workspaceWriteSchema.parse(config.sandbox_workspace_write);
      return {
        sandboxMode: z.string().parse(request.params.sandbox),
        workingDirectory: z.string().parse(request.params.cwd),
        workspaceWrite:
          workspaceWrite === undefined
            ? undefined
            : {
                writableRoots: workspaceWrite.writable_roots,
                excludeTmpdirEnvVar: workspaceWrite.exclude_tmpdir_env_var,
                excludeSlashTmp: workspaceWrite.exclude_slash_tmp,
                networkAccess: workspaceWrite.network_access,
              },
      };
    },
    get launch() {
      return launch;
    },
    get requestCount() {
      return requests.length;
    },
  };
}
