import { describe, it, expect } from "vitest";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import {
  deriveSpawnCards,
  selectSpawnedSessionStatuses,
  spawnProposalId,
  stripProposalFencesFromContent,
} from "./derive-spawn-cards";

function assistant(text: string): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function user(text: string): TranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: "2026-01-01T00:00:00Z",
  };
}

const VALID_PROPOSAL = [
  "Here's my plan:",
  "",
  "```spawn-proposal",
  '{"sessions":[{"name":"auth","branch":"feat/auth","agent":"claude","mode":"fast"}]}',
  "```",
  "",
  "Let me know.",
].join("\n");

describe("deriveSpawnCards", () => {
  it("returns no cards when no message carries a proposal", () => {
    const { spawnCards, validations } = deriveSpawnCards([
      user("Refactor the auth module."),
      assistant("Sure, I'll start by mapping the flow."),
    ]);
    expect(spawnCards).toEqual([]);
    expect(validations.size).toBe(0);
  });

  it("emits a card anchored at the assistant message that proposes sessions", () => {
    const { spawnCards, validations } = deriveSpawnCards([
      user("Split this into sessions."),
      assistant(VALID_PROPOSAL),
    ]);
    expect(spawnCards).toHaveLength(1);
    expect(spawnCards[0]).toEqual({
      kind: "spawn-card",
      proposalId: spawnProposalId(1),
      anchorMessageIndex: 1,
    });
    const validation = validations.get(spawnProposalId(1));
    expect(validation?.kind).toBe("valid");
    if (validation?.kind === "valid") {
      expect(validation.proposal.sessions[0]?.name).toBe("auth");
      // target defaults to "main" when the agent omits it.
      expect(validation.proposal.sessions[0]?.target).toBe("main");
    }
  });

  it("ignores a proposal fence emitted in a user turn (only the agent proposes)", () => {
    const { spawnCards } = deriveSpawnCards([user(VALID_PROPOSAL)]);
    expect(spawnCards).toEqual([]);
  });

  it("surfaces a malformed proposal as an invalid validation, still anchored", () => {
    const bad = ["```spawn-proposal", '{"sessions":[]}', "```"].join("\n");
    const { spawnCards, validations } = deriveSpawnCards([assistant(bad)]);
    expect(spawnCards).toHaveLength(1);
    const validation = validations.get(spawnProposalId(0));
    expect(validation?.kind).toBe("invalid");
  });

  it("derives a stable index-based proposal id across multiple proposals", () => {
    const { spawnCards } = deriveSpawnCards([
      assistant(VALID_PROPOSAL),
      user("ok"),
      assistant(VALID_PROPOSAL),
    ]);
    expect(spawnCards.map((c) => c.anchorMessageIndex)).toEqual([0, 2]);
    expect(spawnCards.map((c) => c.proposalId)).toEqual([
      spawnProposalId(0),
      spawnProposalId(2),
    ]);
  });
});

function session(
  name: string,
  o: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    sessionName: name,
    worktreePath: `/wt/${name}`,
    branchName: `csm/${name}`,
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "fast",
    tddEnabled: false,
    objective: null,
    derivedStatus: "running",
    promptCount: 0,
    derivedLastActivityAt: "2026-01-01T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...o,
  };
}

describe("selectSpawnedSessionStatuses", () => {
  it("returns the sessions this conversation spawned, by sessionName + status", () => {
    const sessions: SessionListItem[] = [
      session("auth", {
        derivedStatus: "awaiting",
        spawnedFrom: {
          source: "chat",
          projectName: "p",
          conversationId: "plc-1",
        },
      }),
      session("other", {
        spawnedFrom: {
          source: "chat",
          projectName: "p",
          conversationId: "plc-9",
        },
      }),
      session("manual"),
    ];
    expect(selectSpawnedSessionStatuses(sessions, "plc-1")).toEqual([
      { sessionName: "auth", derivedStatus: "awaiting" },
    ]);
  });

  it("returns nothing when no conversation is active", () => {
    expect(selectSpawnedSessionStatuses([session("auth")], null)).toEqual([]);
  });
});

describe("stripProposalFencesFromContent", () => {
  it("removes the spawn-proposal fenced block but keeps surrounding prose", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: VALID_PROPOSAL },
    ];
    const out = stripProposalFencesFromContent(content);
    expect(out).toHaveLength(1);
    const block = out[0];
    expect(block?.type).toBe("text");
    if (block?.type === "text") {
      expect(block.text).toContain("Here's my plan:");
      expect(block.text).toContain("Let me know.");
      expect(block.text).not.toContain("spawn-proposal");
      expect(block.text).not.toContain('"sessions"');
    }
  });

  it("drops a text block that is only a proposal fence", () => {
    const onlyFence = ["```spawn-proposal", '{"sessions":[]}', "```"].join(
      "\n",
    );
    const out = stripProposalFencesFromContent([
      { type: "text", text: onlyFence },
    ]);
    expect(out).toEqual([]);
  });

  it("leaves non-text blocks and fence-free text untouched", () => {
    const content: MessageContentBlock[] = [
      { type: "text", text: "Just prose, no proposal." },
      { type: "tool_use", name: "Read", input: { file: "x" } },
    ];
    expect(stripProposalFencesFromContent(content)).toEqual(content);
  });
});
