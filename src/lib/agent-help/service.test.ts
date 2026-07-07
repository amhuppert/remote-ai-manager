/**
 * Unit tests for the help-context service (docs/design/cc-cli/04 §4.2).
 *
 * The service resolves the command's first path segment to a provider, invokes
 * it, caps output at 3 blocks, and turns a per-provider failure into an empty
 * response + a log line so one broken provider never 500s. Providers are
 * injected fakes — no `vi.mock` of internal modules (engineering-principles).
 */
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "@/lib/logging";

import {
  type HelpContextProvider,
  type HelpContextProviderMap,
  type HelpContextRequest,
} from "./providers";
import type { HelpContextBlock } from "./schemas";
import { createHelpContextService } from "./service";

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function providerOf(
  provide: (request: HelpContextRequest) => Promise<HelpContextBlock[]>,
): HelpContextProvider {
  return { provide };
}

function mapWith(
  entries: Record<string, HelpContextProvider>,
): HelpContextProviderMap {
  return new Map(Object.entries(entries));
}

describe("createHelpContextService", () => {
  it("returns the provider's blocks for a matching prefix", async () => {
    const blocks: HelpContextBlock[] = [{ title: "Dev", body: "one server" }];
    const service = createHelpContextService({
      providers: mapWith({ dev: providerOf(async () => blocks) }),
      logger: spyLogger(),
    });

    const response = await service.resolveHelpContext({ command: "dev list" });

    expect(response).toEqual({ blocks });
  });

  it("passes the parsed command segments and identity to the provider", async () => {
    const seen: HelpContextRequest[] = [];
    const service = createHelpContextService({
      providers: mapWith({
        workflow: providerOf(async (req) => {
          seen.push(req);
          return [];
        }),
      }),
      logger: spyLogger(),
    });

    await service.resolveHelpContext({
      command: "workflow task complete",
      project: "repo",
      session: "sess",
      executionId: "exec-1",
      contextId: "ctx-1",
    });

    expect(seen).toEqual([
      {
        command: ["workflow", "task", "complete"],
        project: "repo",
        session: "sess",
        executionId: "exec-1",
        contextId: "ctx-1",
      },
    ]);
  });

  it("returns empty blocks when no provider is registered for the prefix", async () => {
    const service = createHelpContextService({
      providers: mapWith({
        dev: providerOf(async () => [{ title: "x", body: "y" }]),
      }),
      logger: spyLogger(),
    });

    const response = await service.resolveHelpContext({ command: "notify" });

    expect(response).toEqual({ blocks: [] });
  });

  it("caps the response at 3 blocks even if a provider returns more", async () => {
    const many: HelpContextBlock[] = Array.from({ length: 5 }, (_, i) => ({
      title: `t${i}`,
      body: `b${i}`,
    }));
    const service = createHelpContextService({
      providers: mapWith({ dev: providerOf(async () => many) }),
      logger: spyLogger(),
    });

    const response = await service.resolveHelpContext({ command: "dev" });

    expect(response.blocks).toHaveLength(3);
    expect(response.blocks).toEqual(many.slice(0, 3));
  });

  it("logs agent-help.provider_failed and returns empty blocks when a provider throws", async () => {
    const logger = spyLogger();
    const service = createHelpContextService({
      providers: mapWith({
        dev: providerOf(async () => {
          throw new Error("boom");
        }),
      }),
      logger,
    });

    const response = await service.resolveHelpContext({ command: "dev list" });

    expect(response).toEqual({ blocks: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "agent-help.provider_failed",
      expect.objectContaining({ prefix: "dev", command: "dev list" }),
    );
  });

  it("returns empty blocks for a blank command", async () => {
    const service = createHelpContextService({
      providers: mapWith({
        dev: providerOf(async () => [{ title: "x", body: "y" }]),
      }),
      logger: spyLogger(),
    });

    const response = await service.resolveHelpContext({ command: "   " });

    expect(response).toEqual({ blocks: [] });
  });
});
