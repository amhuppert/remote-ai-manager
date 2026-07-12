import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { TicketLinkSummary } from "./schemas";
import { createTicketSessionLinksRouteHandlers } from "./session-link-route-handlers";

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";

const LINKS: Record<string, TicketLinkSummary> = {
  "csm/fix-login": {
    ticketId: "ticket-1",
    projectName: PROJECT_NAME,
    number: 3,
    title: "Fix login",
    active: true,
    linkedAt: "2026-07-10T00:00:01.000Z",
    endedAt: null,
  },
};

function grantedAuth(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "absent" };
    },
  };
}

function rejectedAuth(): AgentAuth {
  return {
    async requireToken() {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

function makeHandlers(auth: AgentAuth = grantedAuth()) {
  return createTicketSessionLinksRouteHandlers({
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    listSessionLinks: async (projectPath) => {
      expect(projectPath).toBe(PROJECT_PATH);
      return LINKS;
    },
    auth,
  });
}

function context(name: string) {
  return { params: Promise.resolve({ name }) };
}

function request(): Request {
  return new Request(
    "http://localhost/api/projects/command-center/tickets/session-links",
  );
}

describe("GET /api/projects/:name/tickets/session-links", () => {
  it("returns the per-session link map for a known project", async () => {
    const response = await makeHandlers().sessionLinksGET(
      request(),
      context(PROJECT_NAME),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LINKS);
  });

  it("returns 404 with a stable code for an unknown project", async () => {
    const response = await makeHandlers().sessionLinksGET(
      request(),
      context("nope"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("project_not_found");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const response = await makeHandlers(rejectedAuth()).sessionLinksGET(
      request(),
      context(PROJECT_NAME),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a missing project-name param with 400 issues before resolution", async () => {
    const handlers = createTicketSessionLinksRouteHandlers({
      resolveProjectPath: async () => {
        throw new Error("resolution must not be reached");
      },
      listSessionLinks: async () => {
        throw new Error("repo must not be reached");
      },
      auth: grantedAuth(),
    });
    const response = await handlers.sessionLinksGET(request(), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
    expect(Array.isArray(body["issues"])).toBe(true);
  });
});
