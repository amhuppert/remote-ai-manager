import { describe, expect, it, vi } from "vitest";

import { ApiCallError } from "@/lib/api/errors";
import {
  startTicketOutputSchema,
  type StartTicketOutput,
  type TicketLinkSummary,
} from "@/lib/tickets/schemas";
import { reconcileQuickTicketStart } from "./start-reconciliation";

const queuedOutput = {
  ticket: {
    id: "ticket-12",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Capture the bug",
    description: "",
    workType: "bug",
    status: "in_progress",
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:01.000Z",
    attachments: [],
    sessions: [],
  },
  sessionName: "ticket-capture-the-bug",
  conversationId: "conversation-12",
  initialPromptQueued: true,
} satisfies StartTicketOutput;

const linked: Record<string, TicketLinkSummary> = {
  "ticket-capture-the-bug": {
    ticketId: "ticket-12",
    projectName: "command-center",
    number: 12,
    title: "Capture the bug",
    active: true,
    linkedAt: "2026-07-19T12:00:01.000Z",
    endedAt: null,
  },
};

describe("quick-ticket start reconciliation", () => {
  it("preserves the direct output, including whether the kickoff prompt queued", async () => {
    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => queuedOutput,
      refetchLinks: vi.fn(),
    });
    expect(result).toEqual({ kind: "started", output: queuedOutput });

    const prepared = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => ({ ...queuedOutput, initialPromptQueued: false }),
      refetchLinks: vi.fn(),
    });
    expect(prepared).toMatchObject({
      kind: "started",
      output: { initialPromptQueued: false },
    });
  });

  it("treats active_session as an already-started success", async () => {
    const refetchLinks = vi.fn(async () => linked);
    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "already active",
          "active_session",
          undefined,
          { sessionName: "ticket-capture-the-bug" },
          409,
        );
      },
      refetchLinks,
    });

    expect(refetchLinks).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "active",
      sessionName: "ticket-capture-the-bug",
    });
  });

  it("does not treat a foreign active-session name collision as this ticket's success", async () => {
    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "already active",
          "active_session",
          undefined,
          { sessionName: "ticket-capture-the-bug" },
          409,
        );
      },
      refetchLinks: async () => ({
        "ticket-capture-the-bug": {
          ...linked["ticket-capture-the-bug"]!,
          ticketId: "foreign-ticket",
        },
      }),
    });

    expect(result).toMatchObject({ kind: "failed" });
  });

  it("refetches links for start_in_progress and reports the observed state", async () => {
    const refetchLinks = vi.fn(async () => linked);
    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "start in progress",
          "start_in_progress",
          undefined,
          undefined,
          409,
        );
      },
      refetchLinks,
    });

    expect(refetchLinks).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "active",
      sessionName: "ticket-capture-the-bug",
    });
  });

  it("polls when an ambiguous start has not committed its session link yet", async () => {
    const refetchLinks = vi
      .fn<() => Promise<Record<string, TicketLinkSummary>>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(linked);
    const wait = vi.fn(async () => undefined);

    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "start in progress",
          "start_in_progress",
          undefined,
          undefined,
          409,
        );
      },
      refetchLinks,
      wait,
    });

    expect(wait).toHaveBeenCalledOnce();
    expect(refetchLinks).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      kind: "active",
      sessionName: "ticket-capture-the-bug",
    });
  });

  it("keeps reconciling while a longer-running start is still committing its session link", async () => {
    let elapsedMilliseconds = 0;
    const refetchLinks = vi.fn(async () =>
      elapsedMilliseconds >= 5_000 ? linked : {},
    );
    const wait = vi.fn(async (milliseconds: number) => {
      elapsedMilliseconds += milliseconds;
    });

    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "start in progress",
          "start_in_progress",
          undefined,
          undefined,
          409,
        );
      },
      refetchLinks,
      wait,
    });

    expect(elapsedMilliseconds).toBe(5_000);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(refetchLinks).toHaveBeenCalledTimes(6);
    expect(result).toEqual({
      kind: "active",
      sessionName: "ticket-capture-the-bug",
    });
  });

  it("refetches after network and 5xx ambiguity before declaring failure", async () => {
    for (const error of [
      new ApiCallError("network failed"),
      new ApiCallError("server failed", undefined, undefined, undefined, 503),
    ]) {
      const recovered = await reconcileQuickTicketStart({
        ticketId: "ticket-12",
        start: async () => {
          throw error;
        },
        refetchLinks: async () => linked,
      });
      expect(recovered).toEqual({
        kind: "active",
        sessionName: "ticket-capture-the-bug",
      });
    }

    const failed = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "server failed",
          undefined,
          undefined,
          undefined,
          503,
        );
      },
      refetchLinks: async () => ({}),
      wait: async () => undefined,
    });
    expect(failed).toMatchObject({ kind: "failed" });
  });

  it("polls session links after a fetch TypeError before preserving the transport failure", async () => {
    const transportError = new TypeError("Failed to fetch");
    const refetchLinks = vi.fn(async () => ({}));
    const wait = vi.fn(async () => undefined);

    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw transportError;
      },
      refetchLinks,
      wait,
    });

    expect(refetchLinks).toHaveBeenCalledTimes(31);
    expect(wait).toHaveBeenCalledTimes(30);
    expect(result).toEqual({ kind: "failed", error: transportError });
  });

  it("reconciles a committed link after a malformed successful response", async () => {
    const refetchLinks = vi.fn(async () => linked);

    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => startTicketOutputSchema.parse({ malformed: true }),
      refetchLinks,
    });

    expect(refetchLinks).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "active",
      sessionName: "ticket-capture-the-bug",
    });
  });

  it("does not refetch after an unambiguous client rejection", async () => {
    const refetchLinks = vi.fn(async () => linked);
    const result = await reconcileQuickTicketStart({
      ticketId: "ticket-12",
      start: async () => {
        throw new ApiCallError(
          "invalid request",
          "validation_failed",
          undefined,
          undefined,
          400,
        );
      },
      refetchLinks,
    });

    expect(refetchLinks).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "failed" });
  });
});
