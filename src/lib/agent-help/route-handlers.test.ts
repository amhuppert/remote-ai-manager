/**
 * Tests for the help-context route handler (docs/design/cc-cli/04 §4.2).
 *
 * The handler is token-gated exactly like other agent endpoints, and delegates
 * to the REAL service over injected fake providers — so these tests exercise the
 * full stack (gate → parse → provider → cap → guard) without a running server.
 * An unknown command returns 200 { blocks: [] }, never 404: the CLI treats this
 * endpoint as garnish and a 404 would be indistinguishable from a wrong URL.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { Logger } from "@/lib/logging";

import {
  type HelpContextProvider,
  type HelpContextProviderMap,
} from "./providers";
import { createHelpContextService } from "./service";
import { createAgentHelpRouteHandlers } from "./route-handlers";

const TOKEN = "good-token";

/** Auth that accepts only the exact bearer token, mirroring the real gate. */
function tokenAuth(expected: string): AgentAuth {
  return {
    async requireToken(request: Request): Promise<Response | null> {
      const header = request.headers.get("authorization");
      if (header === `Bearer ${expected}`) return null;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    },
    async validateOptionalToken(request: Request) {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" as const };
      if (header === `Bearer ${expected}`) return { kind: "valid" as const };
      return { kind: "invalid" as const };
    },
  };
}

function spyLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function providerOf(
  provide: HelpContextProvider["provide"],
): HelpContextProvider {
  return { provide };
}

function makeHandlers(
  providers: HelpContextProviderMap,
  logger: Logger = spyLogger(),
) {
  const service = createHelpContextService({ providers, logger });
  return createAgentHelpRouteHandlers({ auth: tokenAuth(TOKEN), service });
}

function makeRequest(queryString: string, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest(
    `http://localhost/api/agent/help-context${queryString}`,
    { method: "GET", headers },
  );
}

describe("help-context route handler", () => {
  it("rejects a request without the token with 401 and does no work", async () => {
    const provide = vi.fn();
    const handlers = makeHandlers(new Map([["dev", providerOf(provide)]]));

    const response = await handlers.helpContextGET(
      makeRequest("?command=dev%20list", null),
    );

    expect(response.status).toBe(401);
    expect(provide).not.toHaveBeenCalled();
  });

  it("passes a provider's blocks through on success", async () => {
    const handlers = makeHandlers(
      new Map([
        [
          "dev",
          providerOf(async () => [
            {
              title: "Dev servers",
              body: "web — running — http://localhost:3000",
            },
          ]),
        ],
      ]),
    );

    const response = await handlers.helpContextGET(
      makeRequest("?command=dev%20list"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      blocks: [
        { title: "Dev servers", body: "web — running — http://localhost:3000" },
      ],
    });
  });

  it("forwards identity params to the provider", async () => {
    const seen: unknown[] = [];
    const handlers = makeHandlers(
      new Map([
        [
          "workflow",
          providerOf(async (req) => {
            seen.push(req);
            return [];
          }),
        ],
      ]),
    );

    await handlers.helpContextGET(
      makeRequest(
        "?command=workflow%20task%20complete&project=repo&session=sess&executionId=exec-1&contextId=ctx-1",
      ),
    );

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

  it("returns 200 with empty blocks for an unknown command (never 404)", async () => {
    const handlers = makeHandlers(
      new Map([["dev", providerOf(async () => [{ title: "x", body: "y" }])]]),
    );

    const response = await handlers.helpContextGET(
      makeRequest("?command=totally%20unknown"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ blocks: [] });
  });

  it("returns 200 with empty blocks when the command param is missing", async () => {
    const handlers = makeHandlers(
      new Map([["dev", providerOf(async () => [{ title: "x", body: "y" }])]]),
    );

    const response = await handlers.helpContextGET(makeRequest(""));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ blocks: [] });
  });

  it("logs the failure and returns 200 empty blocks when a provider throws", async () => {
    const logger = spyLogger();
    const handlers = makeHandlers(
      new Map([
        [
          "dev",
          providerOf(async () => {
            throw new Error("provider exploded");
          }),
        ],
      ]),
      logger,
    );

    const response = await handlers.helpContextGET(
      makeRequest("?command=dev%20list"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ blocks: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "agent-help.provider_failed",
      expect.objectContaining({ prefix: "dev" }),
    );
  });
});
