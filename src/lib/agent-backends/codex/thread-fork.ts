/**
 * One-shot `thread/fork`: a bounded app-server process that copies a Codex
 * thread through `lastTurnId` (inclusive) into a new persisted thread and
 * exits. It never starts a model turn; the fork's first conversation turn
 * resumes the new thread with its full per-turn configuration.
 *
 * `thread/fork` loads the new thread, which starts its MCP servers. Nothing in
 * a metadata-only fork needs them, so every native server the listing
 * recognizes is disabled for this process — the same suppression the
 * conversation runtime applies to unselected servers.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { buildChildEnv } from "@/lib/shared/child-env";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  createCodexAppServerClient,
  type AppServerClient,
  type AppServerClientOptions,
} from "./app-server-client";
import type { CodexForkThreadInput } from "./continuity";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpListInput,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";
import { CODEX_NATIVE_MEMORY_CONFIG } from "./native-memory";
import { toStringEnv } from "./shared";

const logger = createLogger("codex:thread-fork");

export interface CodexThreadForkDeps {
  createAppServer(options: AppServerClientOptions): AppServerClient;
  buildEnv(): Record<string, string>;
  listNativeMcpServers(
    input: NativeCodexMcpListInput,
  ): Promise<NativeCodexMcpServer[]>;
}

const defaults: CodexThreadForkDeps = {
  createAppServer: createCodexAppServerClient,
  buildEnv: () => toStringEnv(buildChildEnv()),
  listNativeMcpServers: listNativeCodexMcpServers,
};

const forkResponseSchema = z.object({ thread: z.object({ id: z.string() }) });

/** Forks `threadId` through `lastTurnId`; resolves the new thread's id. */
export async function forkCodexThread(
  input: CodexForkThreadInput,
  dependencies: Partial<CodexThreadForkDeps> = {},
): Promise<string> {
  const deps = { ...defaults, ...dependencies };
  const env = deps.buildEnv();
  const nativeServers = await deps.listNativeMcpServers({
    cwd: input.projectPath,
    env,
  });
  const config: Record<string, unknown> = { ...CODEX_NATIVE_MEMORY_CONFIG };
  if (nativeServers.length > 0)
    config.mcp_servers = buildCodexMcpServersConfig({
      managedMcpServers: {},
      nativeServers,
    });

  let failure: Error | undefined;
  const client = deps.createAppServer({
    cwd: input.projectPath,
    env,
    config,
    async onFrame() {},
    onFailure(error) {
      failure = error;
    },
  });

  let threadId: string;
  try {
    await client.request("initialize", {
      clientInfo: { name: "command-center", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    });
    client.notify("initialized");
    const response = forkResponseSchema.safeParse(
      await client.request("thread/fork", {
        threadId: input.threadId,
        lastTurnId: input.lastTurnId,
        excludeTurns: true,
      }),
    );
    if (failure) throw failure;
    if (!response.success) throw new Error("thread/fork returned no thread id");
    threadId = response.data.thread.id;
  } catch (err) {
    await closeQuietly(client, input);
    throw err;
  }
  // The thread already exists and is valid; a cleanup failure is operational
  // noise for this fork, not a reason to discard it.
  await closeQuietly(client, input);
  return threadId;
}

async function closeQuietly(
  client: AppServerClient,
  input: CodexForkThreadInput,
): Promise<void> {
  try {
    await client.close();
  } catch (err) {
    logger.warn("thread_fork.cleanup_failed", {
      projectPath: input.projectPath,
      sourceThreadRef: input.threadId,
      error: getErrorMessage(err),
    });
  }
}
