import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  extractProposal,
  validateProposal,
  SPAWN_PROPOSAL_FENCE,
} from "@/lib/chat-spawning/proposal-validator";
import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "./system-prompt";

describe("PROJECT_CC_CONTEXT", () => {
  it("is a non-empty command-center orientation string", () => {
    expect(PROJECT_CC_CONTEXT).toMatch(/^<command-center>/);
    expect(PROJECT_CC_CONTEXT.length).toBeGreaterThan(0);
  });

  it("does not promise a dev server (no dev-server language)", () => {
    const lower = PROJECT_CC_CONTEXT.toLowerCase();
    expect(lower).not.toContain("ensure_dev_server");
    expect(lower).not.toContain("dev server");
    expect(lower).not.toContain("dev-server");
    expect(lower).not.toContain("get_dev_servers");
  });

  it("identifies the main / repo-root worktree execution context", () => {
    expect(PROJECT_CC_CONTEXT.toLowerCase()).toContain("main");
  });
});

describe("PROJECT_SPAWN_INSTRUCTIONS", () => {
  it("uses the same fence marker the proposal parser extracts", () => {
    expect(PROJECT_SPAWN_INSTRUCTIONS).toContain(SPAWN_PROPOSAL_FENCE);
  });

  it("teaches an example proposal that conforms to the spawn wire shape", () => {
    // The example block is parsed by the SAME extractor/validator the
    // production path runs, so the instruction can never drift from the schema.
    const candidate = extractProposal(PROJECT_SPAWN_INSTRUCTIONS);
    expect(candidate).not.toBeNull();
    const validation = validateProposal(candidate);
    expect(validation.kind).toBe("valid");
    if (validation.kind === "valid") {
      expect(validation.proposal.sessions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("frames spawning as a proposal the user creates — not the agent", () => {
    expect(PROJECT_SPAWN_INSTRUCTIONS).toMatch(/propose/i);
    expect(PROJECT_SPAWN_INSTRUCTIONS).toMatch(
      /never create them yourself|do not claim/i,
    );
  });

  it("documents the agent and mode options", () => {
    for (const token of ["claude", "codex", "dual", "normal", "optimistic"]) {
      expect(PROJECT_SPAWN_INSTRUCTIONS).toContain(token);
    }
  });

  it("does not teach the removed legacy modes (fast, focus)", () => {
    expect(PROJECT_SPAWN_INSTRUCTIONS).not.toMatch(/"mode":\s*"(fast|focus)"/);
    expect(PROJECT_SPAWN_INSTRUCTIONS).not.toMatch(/`fast`|`focus`/);
  });
});

describe("spawn instructions are project-conversation-only", () => {
  it("is injected into the system prompt only behind the isProjectConversation gate", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const actorSrc = readFileSync(
      resolve(here, "../workflows/conversation/actor-implementations.ts"),
      "utf8",
    );
    // The constant flows into `sessionInstructions` exclusively through the
    // project gate; a session agent (CC_CONTEXT branch) never receives it.
    expect(actorSrc).toMatch(
      /isProjectConversation\s*\?\s*PROJECT_SPAWN_INSTRUCTIONS\s*:\s*null/,
    );
  });
});
