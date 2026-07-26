import { describe, it, expect } from "vitest";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  CHARTER_SUPERSEDES_NOTICE,
  CollaborationSessionContextError,
  EMPTY_COLLABORATION_SESSION_CONTEXT,
  MalformedCollaborationSessionContextError,
  MissingCollaborationSessionContextError,
  buildLaneSystemInstructions,
  collaborationSessionContextSchema,
  parseSessionContextForExecution,
  prefixPromptWithTicketBlock,
  resolveCollaborationSessionContext,
  type CollaborationSessionContext,
  type CollaborationSessionContextResolverDeps,
} from "./session-context";

const CHARTER_TEXT =
  "# Session Alignment (governing context)\nMission: ship it.";
const TICKET_BLOCK =
  "<active-ticket>\nidentifier: command-center#12\n</active-ticket>";

function charter(
  overrides: Partial<CollaborationSessionContext["alignment"] & object> = {},
): NonNullable<CollaborationSessionContext["alignment"]> {
  return {
    version: 4,
    contentHash: "hash-4",
    text: CHARTER_TEXT,
    ...overrides,
  };
}

interface ResolverFakeOptions {
  charterResult?: NonNullable<CollaborationSessionContext["alignment"]> | null;
  charterError?: Error;
  ticketResult?: string | null;
  ticketError?: Error;
}

function createResolverDeps(options: ResolverFakeOptions): {
  deps: CollaborationSessionContextResolverDeps;
  charterCalls: Array<{ projectPath: string; sessionName: string }>;
  ticketCalls: Array<{ projectPath: string; sessionName: string }>;
} {
  const charterCalls: Array<{ projectPath: string; sessionName: string }> = [];
  const ticketCalls: Array<{ projectPath: string; sessionName: string }> = [];
  const deps: CollaborationSessionContextResolverDeps = {
    async captureActiveCharter(projectPath, sessionName) {
      charterCalls.push({ projectPath, sessionName });
      if (options.charterError) throw options.charterError;
      return options.charterResult ?? null;
    },
    async getLiveTicketBlock(projectPath, sessionName) {
      ticketCalls.push({ projectPath, sessionName });
      if (options.ticketError) throw options.ticketError;
      return options.ticketResult ?? null;
    },
  };
  return { deps, charterCalls, ticketCalls };
}

const IDENTITY = { projectPath: "/p", sessionName: "s" };

describe("collaborationSessionContextSchema", () => {
  it("accepts a fully-populated snapshot including the digest snapshot path", () => {
    const parsed = collaborationSessionContextSchema.parse({
      alignment: { ...charter(), snapshotPath: ".cc/x/hash-4.md" },
      activeTicketBlock: TICKET_BLOCK,
    });
    expect(parsed.alignment?.snapshotPath).toBe(".cc/x/hash-4.md");
    expect(parsed.activeTicketBlock).toBe(TICKET_BLOCK);
  });

  it("accepts the empty projection", () => {
    expect(
      collaborationSessionContextSchema.parse(
        EMPTY_COLLABORATION_SESSION_CONTEXT,
      ),
    ).toEqual({ alignment: null, activeTicketBlock: null });
  });

  it("rejects a non-integer charter version", () => {
    expect(
      collaborationSessionContextSchema.safeParse({
        alignment: charter({ version: 1.5 }),
        activeTicketBlock: null,
      }).success,
    ).toBe(false);
  });
});

describe("parseSessionContextForExecution", () => {
  it("returns the parsed snapshot for a valid context", () => {
    const value = {
      alignment: charter(),
      activeTicketBlock: TICKET_BLOCK,
    };
    expect(parseSessionContextForExecution(value)).toEqual(value);
  });

  it("rejects an absent context distinctly from a malformed one", () => {
    for (const absent of [undefined, null]) {
      expect(() => parseSessionContextForExecution(absent)).toThrow(
        MissingCollaborationSessionContextError,
      );
    }
    expect(() => parseSessionContextForExecution({ alignment: null })).toThrow(
      MalformedCollaborationSessionContextError,
    );
    // The absent error must not be catchable as the malformed one.
    expect(() => parseSessionContextForExecution(undefined)).not.toThrow(
      MalformedCollaborationSessionContextError,
    );
  });

  it("rejects malformed shapes: wrong type, missing field, wrong field type", () => {
    const malformed: unknown[] = [
      "not-an-object",
      42,
      {},
      { activeTicketBlock: TICKET_BLOCK },
      { alignment: { version: 1, contentHash: "h" }, activeTicketBlock: null },
      { alignment: charter(), activeTicketBlock: 7 },
    ];
    for (const value of malformed) {
      expect(() => parseSessionContextForExecution(value)).toThrow(
        MalformedCollaborationSessionContextError,
      );
    }
  });

  it("lets a caller catch either failure through one typed base error", () => {
    for (const value of [undefined, "nope"]) {
      let caught: unknown;
      try {
        parseSessionContextForExecution(value);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CollaborationSessionContextError);
      expect((caught as CollaborationSessionContextError).reason).toBe(
        value === undefined ? "absent" : "malformed",
      );
    }
  });
});

describe("buildLaneSystemInstructions", () => {
  it("returns null when no charter governs the run", () => {
    expect(
      buildLaneSystemInstructions(EMPTY_COLLABORATION_SESSION_CONTEXT),
    ).toBeNull();
    expect(
      buildLaneSystemInstructions({
        alignment: null,
        activeTicketBlock: TICKET_BLOCK,
      }),
    ).toBeNull();
  });

  it("delivers the charter text verbatim followed by exactly one supersedes sentence", () => {
    const instructions = buildLaneSystemInstructions({
      alignment: charter(),
      activeTicketBlock: null,
    });
    expect(instructions).not.toBeNull();
    const text = instructions ?? "";
    expect(text.startsWith(CHARTER_TEXT)).toBe(true);
    expect(text).toContain(CHARTER_SUPERSEDES_NOTICE);
    expect(text.split(CHARTER_SUPERSEDES_NOTICE)).toHaveLength(2);
    expect(text.indexOf(CHARTER_TEXT)).toBeLessThan(
      text.indexOf(CHARTER_SUPERSEDES_NOTICE),
    );
  });

  it("does not fold the ticket block into the governing instructions", () => {
    const text =
      buildLaneSystemInstructions({
        alignment: charter(),
        activeTicketBlock: TICKET_BLOCK,
      }) ?? "";
    expect(text).not.toContain(TICKET_BLOCK);
  });

  it("never emits the /align suggestion nudge", () => {
    expect(
      buildLaneSystemInstructions({
        alignment: charter(),
        activeTicketBlock: null,
      }),
    ).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
  });
});

describe("prefixPromptWithTicketBlock", () => {
  it("prepends the block verbatim with one blank line", () => {
    expect(
      prefixPromptWithTicketBlock(
        { alignment: null, activeTicketBlock: TICKET_BLOCK },
        "Draft an answer.",
      ),
    ).toBe(`${TICKET_BLOCK}\n\nDraft an answer.`);
  });

  it("returns the prompt unchanged when no ticket is linked", () => {
    expect(
      prefixPromptWithTicketBlock(
        { alignment: charter(), activeTicketBlock: null },
        "Draft an answer.",
      ),
    ).toBe("Draft an answer.");
  });

  it("adds the block exactly once per prompt", () => {
    const prompt = prefixPromptWithTicketBlock(
      { alignment: null, activeTicketBlock: TICKET_BLOCK },
      "Draft an answer.",
    );
    expect(prompt.split(TICKET_BLOCK)).toHaveLength(2);
  });
});

describe("resolveCollaborationSessionContext", () => {
  it("captures both sources for a user-invoked normal-session run", async () => {
    const { deps, charterCalls, ticketCalls } = createResolverDeps({
      charterResult: charter(),
      ticketResult: TICKET_BLOCK,
    });
    const capture = await resolveCollaborationSessionContext(deps, {
      ...IDENTITY,
      creationMode: "normal",
    });
    expect(capture.context).toEqual({
      alignment: charter(),
      activeTicketBlock: TICKET_BLOCK,
    });
    expect(charterCalls).toEqual([IDENTITY]);
    expect(ticketCalls).toEqual([IDENTITY]);
  });

  it("projects charter-only and ticket-only runs", async () => {
    const charterOnly = await resolveCollaborationSessionContext(
      createResolverDeps({ charterResult: charter(), ticketResult: null }).deps,
      { ...IDENTITY, creationMode: "normal" },
    );
    expect(charterOnly.context).toEqual({
      alignment: charter(),
      activeTicketBlock: null,
    });

    const ticketOnly = await resolveCollaborationSessionContext(
      createResolverDeps({ charterResult: null, ticketResult: TICKET_BLOCK })
        .deps,
      { ...IDENTITY, creationMode: "normal" },
    );
    expect(ticketOnly.context).toEqual({
      alignment: null,
      activeTicketBlock: TICKET_BLOCK,
    });
  });

  it("projects an empty context when neither source has anything", async () => {
    const capture = await resolveCollaborationSessionContext(
      createResolverDeps({ charterResult: null, ticketResult: null }).deps,
      { ...IDENTITY, creationMode: "normal" },
    );
    expect(capture.context).toEqual(EMPTY_COLLABORATION_SESSION_CONTEXT);
  });

  it("skips the charter read for ineligible sessions but still reads the ticket", async () => {
    const ineligible: Array<SessionState["creationMode"] | undefined> = [
      "optimistic",
      undefined,
    ];
    for (const creationMode of ineligible) {
      const { deps, charterCalls, ticketCalls } = createResolverDeps({
        charterResult: charter(),
        ticketResult: TICKET_BLOCK,
      });
      const capture = await resolveCollaborationSessionContext(deps, {
        ...IDENTITY,
        creationMode,
      });
      expect(capture.context).toEqual({
        alignment: null,
        activeTicketBlock: TICKET_BLOCK,
      });
      expect(charterCalls).toEqual([]);
      expect(ticketCalls).toEqual([IDENTITY]);
    }
  });

  it("fails closed on a charter read failure without reading the ticket", async () => {
    const { deps, ticketCalls } = createResolverDeps({
      charterError: new Error("charter store offline"),
      ticketResult: TICKET_BLOCK,
    });
    await expect(
      resolveCollaborationSessionContext(deps, {
        ...IDENTITY,
        creationMode: "normal",
      }),
    ).rejects.toThrow(/charter/i);
    expect(ticketCalls).toEqual([]);
  });

  it("degrades a ticket read failure to a null block and keeps the charter", async () => {
    const { deps } = createResolverDeps({
      charterResult: charter(),
      ticketError: new Error("ticket store offline"),
    });
    const capture = await resolveCollaborationSessionContext(deps, {
      ...IDENTITY,
      creationMode: "normal",
    });
    expect(capture.context).toEqual({
      alignment: charter(),
      activeTicketBlock: null,
    });
  });

  it("attributes a degraded ticket read to the ticket source", async () => {
    const { deps } = createResolverDeps({
      charterResult: charter(),
      ticketError: new Error("ticket store offline"),
    });
    const capture = await resolveCollaborationSessionContext(deps, {
      ...IDENTITY,
      creationMode: "normal",
    });
    // The caller cannot tell "no ticket" from "ticket unreadable" by looking at
    // the snapshot alone, so the degradation is reported alongside it.
    expect(capture.degraded).toEqual({
      source: "ticket",
      error: "ticket store offline",
    });
  });

  it("reports no degradation when both sources resolve", async () => {
    const { deps } = createResolverDeps({
      charterResult: charter(),
      ticketResult: TICKET_BLOCK,
    });
    const capture = await resolveCollaborationSessionContext(deps, {
      ...IDENTITY,
      creationMode: "normal",
    });
    expect(capture.degraded).toBeNull();
  });

  it("reports no degradation when the session simply has no ticket", async () => {
    const { deps } = createResolverDeps({
      charterResult: charter(),
      ticketResult: null,
    });
    const capture = await resolveCollaborationSessionContext(deps, {
      ...IDENTITY,
      creationMode: "normal",
    });
    expect(capture.degraded).toBeNull();
  });

  it("never substitutes the /align suggestion for a missing charter", async () => {
    const { context } = await resolveCollaborationSessionContext(
      createResolverDeps({ charterResult: null, ticketResult: TICKET_BLOCK })
        .deps,
      { ...IDENTITY, creationMode: "normal" },
    );
    expect(context.alignment).toBeNull();
    expect(JSON.stringify(context)).not.toContain(
      ALIGN_SUGGESTION_INSTRUCTIONS,
    );
    expect(buildLaneSystemInstructions(context)).toBeNull();
  });

  it("produces a context that survives the strict execution parser", async () => {
    const { context } = await resolveCollaborationSessionContext(
      createResolverDeps({
        charterResult: charter({ snapshotPath: ".cc/x/hash-4.md" }),
        ticketResult: TICKET_BLOCK,
      }).deps,
      { ...IDENTITY, creationMode: "normal" },
    );
    expect(
      parseSessionContextForExecution(JSON.parse(JSON.stringify(context))),
    ).toEqual(context);
  });
});
