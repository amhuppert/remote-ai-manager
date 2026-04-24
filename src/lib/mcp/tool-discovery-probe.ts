/**
 * Direct MCP SDK probes for tool discovery.
 *
 * Opens a short-lived MCP client to a single server, lists its tools, and
 * tears down the process/stream on completion or failure. Strict startup and
 * tool-call timeouts guarantee the probe never blocks indefinitely even if the
 * server hangs. All error paths surface through sanitized diagnostics that do
 * not leak stderr, environment values, or raw exception messages.
 *
 * The production client factory dispatches on `McpCanonicalServerConfig.transport`
 * to build stdio, streamable-http, or SSE transports. Tests inject a fake
 * factory so no real process is spawned.
 */
import { createLogger } from "@/lib/logging";
import type {
  McpDiagnostic,
  McpDiscoveredTool,
  McpToolInventoryResult,
} from "@/lib/schemas";

import type { McpCanonicalServerConfig } from "./types";

const logger = createLogger("mcp.tool-discovery");

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export interface DirectToolProbeInput {
  serverKey: string;
  server: McpCanonicalServerConfig;
  /** Optional overrides for the default timeouts (e.g. per-server). */
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface DirectToolProbeClient {
  /** Open the underlying transport and perform MCP initialization. */
  connect(options: { signal: AbortSignal }): Promise<void>;
  /** Return the server's advertised tools. */
  listTools(options: { signal: AbortSignal }): Promise<McpDiscoveredTool[]>;
  /** Tear down the transport and any spawned subprocess. Idempotent. */
  close(): Promise<void>;
}

export interface DirectToolProbeClientFactoryInput {
  serverKey: string;
  server: McpCanonicalServerConfig;
}

export interface DirectToolProbeDeps {
  createClient(
    input: DirectToolProbeClientFactoryInput,
  ): Promise<DirectToolProbeClient>;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export type DirectToolProbe = (
  input: DirectToolProbeInput,
) => Promise<McpToolInventoryResult>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDirectToolProbe(
  deps: DirectToolProbeDeps,
): DirectToolProbe {
  const defaultStartupMs = deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const defaultToolMs = deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return async function probe(
    input: DirectToolProbeInput,
  ): Promise<McpToolInventoryResult> {
    const startupTimeoutMs = input.startupTimeoutMs ?? defaultStartupMs;
    const toolTimeoutMs = input.toolTimeoutMs ?? defaultToolMs;

    let client: DirectToolProbeClient | undefined;
    try {
      client = await deps.createClient({
        serverKey: input.serverKey,
        server: input.server,
      });
    } catch (err) {
      logger.warn("probe.factory_failed", {
        serverKey: input.serverKey,
        transport: input.server.transport,
      });
      return errorResult(
        "mcp.probe.factory_failed",
        "failed to initialize probe",
        {
          serverKey: input.serverKey,
        },
      );
    }

    try {
      try {
        await withTimeout(
          (signal) => client!.connect({ signal }),
          startupTimeoutMs,
          "startup",
        );
      } catch (err) {
        if (err instanceof ProbeTimeoutError) {
          logger.warn("probe.startup_timeout", {
            serverKey: input.serverKey,
            transport: input.server.transport,
            timeoutMs: startupTimeoutMs,
          });
          return errorResult(
            "mcp.probe.startup_timeout",
            "connection startup timed out",
            { serverKey: input.serverKey },
          );
        }
        logger.warn("probe.connect_failed", {
          serverKey: input.serverKey,
          transport: input.server.transport,
        });
        return errorResult("mcp.probe.connect_failed", "connection failed", {
          serverKey: input.serverKey,
        });
      }

      try {
        const tools = await withTimeout(
          (signal) => client!.listTools({ signal }),
          toolTimeoutMs,
          "list-tools",
        );
        logger.info("probe.success", {
          serverKey: input.serverKey,
          transport: input.server.transport,
          toolCount: tools.length,
        });
        return {
          state: "ready",
          tools,
          diagnostics: [],
          refreshedAt: new Date().toISOString(),
        };
      } catch (err) {
        if (err instanceof ProbeTimeoutError) {
          logger.warn("probe.list_tools_timeout", {
            serverKey: input.serverKey,
            transport: input.server.transport,
            timeoutMs: toolTimeoutMs,
          });
          return errorResult(
            "mcp.probe.list_tools_timeout",
            "listing tools timed out",
            { serverKey: input.serverKey },
          );
        }
        logger.warn("probe.list_tools_failed", {
          serverKey: input.serverKey,
          transport: input.server.transport,
        });
        return errorResult(
          "mcp.probe.list_tools_failed",
          "listing tools failed",
          { serverKey: input.serverKey },
        );
      }
    } finally {
      await safeClose(client, input.serverKey);
    }
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

class ProbeTimeoutError extends Error {
  constructor(readonly phase: "startup" | "list-tools") {
    super(`probe timeout: ${phase}`);
  }
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  phase: "startup" | "list-tools",
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeoutError(phase));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeClose(
  client: DirectToolProbeClient | undefined,
  serverKey: string,
): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (err) {
    logger.warn("probe.close_failed", { serverKey });
  }
}

function errorResult(
  code: string,
  message: string,
  context: { serverKey: string },
): McpToolInventoryResult {
  const diagnostic: McpDiagnostic = {
    severity: "error",
    code,
    message,
    serverKey: context.serverKey,
  };
  return {
    state: "error",
    tools: [],
    diagnostics: [diagnostic],
  };
}
