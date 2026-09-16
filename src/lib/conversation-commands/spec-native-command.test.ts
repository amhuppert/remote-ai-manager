// @vitest-inputs .claude/commands/**/*.md .claude/skills/*/SKILL.md
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverCommands } from "@/lib/commands/service";

import { parseConversationCommand } from "./parse";

const COMMAND_PATH = path.join(process.cwd(), ".claude", "commands", "spec.md");

describe("native /spec command", () => {
  it("is discovered by the composer and CLI from the native command catalog", async () => {
    const commands = await discoverCommands(process.cwd(), "claude");

    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "/spec",
        type: "command",
        source: "project",
      }),
    );
  });

  it("travels through the SDK command path instead of CC command interception", () => {
    expect(parseConversationCommand("/spec durable audit log")).toBeNull();
  });

  it("instructs the agent to author durably with an explicit elicitation handoff", async () => {
    const commandText = await readFile(COMMAND_PATH, "utf8");

    expect(commandText).toContain("cctl spec create");
    expect(commandText).toContain("cctl spec draft");
    expect(commandText).toContain("cctl spec list");
    // The first save IS the creation: one atomic call with the element file,
    // never the retired create-then-draft two-step.
    expect(commandText).toMatch(/cctl spec create[\s\S]{0,250}--file/);
    expect(commandText).not.toContain("then immediately save");
    expect(commandText).toContain("slug_taken");
    expect(commandText).toContain("cctl ask");
    expect(commandText).toContain("A skipped question permits best judgment");
    expect(commandText).toMatch(
      /After a successful ask[\s\S]{0,160}end the turn/i,
    );
    expect(commandText).toContain(
      "elapsed time is neither an answer nor approval",
    );
    expect(commandText).toContain("cctl spec attention withdraw");
    expect(commandText).toMatch(/conversations author/i);
    expect(commandText).toMatch(/Studio reviews/i);
  });
});
