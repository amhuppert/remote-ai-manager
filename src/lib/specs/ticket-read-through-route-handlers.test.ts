import { describe, expect, it, vi } from "vitest";

import {
  createTicketReadThroughRouteHandlers,
  type TicketReadThroughRouteDeps,
} from "./ticket-read-through-route-handlers";

function context(name: string, number: string) {
  return { params: Promise.resolve({ name, number }) };
}

describe("ticket read-through route", () => {
  it("resolves the project and reads current linked spec state through LinksService", async () => {
    const getTicketReadThrough = vi.fn(async () => ({
      ticket: { id: "ticket-12" },
      specs: [
        {
          specId: "spec-1",
          slug: "native-sdd",
          name: "Native SDD",
          revision: 4,
          phase: { primary: "executing" as const },
          criteriaProgress: { proven: 7, total: 12 },
          linkedTasks: [],
        },
      ],
    }));
    const getLinksService = vi.fn(async () => ({ getTicketReadThrough }));
    const deps: TicketReadThroughRouteDeps = {
      resolveProjectPath: async (name) =>
        name === "command-center" ? "/repos/command-center" : null,
      getLinksService,
    };
    const handlers = createTicketReadThroughRouteHandlers(deps);

    const response = await handlers.GET(
      new Request(
        "http://cc.test/api/specs/command-center/ticket-read-through/12",
      ),
      context("command-center", "12"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      specs: [
        expect.objectContaining({
          specId: "spec-1",
          phase: { primary: "executing" },
        }),
      ],
    });
    expect(getTicketReadThrough).toHaveBeenCalledWith({
      projectName: "command-center",
      number: 12,
    });
    expect(getLinksService).toHaveBeenCalledWith("/repos/command-center");
  });

  it("rejects an invalid ticket number before constructing project services", async () => {
    const getLinksService = vi.fn();
    const handlers = createTicketReadThroughRouteHandlers({
      resolveProjectPath: async () => "/repos/command-center",
      getLinksService,
    });

    const response = await handlers.GET(
      new Request(
        "http://cc.test/api/specs/command-center/ticket-read-through/nope",
      ),
      context("command-center", "nope"),
    );

    expect(response.status).toBe(400);
    expect(getLinksService).not.toHaveBeenCalled();
  });
});
