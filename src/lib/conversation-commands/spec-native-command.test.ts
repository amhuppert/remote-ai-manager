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

  it("instructs the agent to author durably with non-blocking elicitation", async () => {
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
    expect(commandText).toMatch(/skippable/i);
    expect(commandText).toMatch(/visible/i);
    expect(commandText).toMatch(/prun/i);
    expect(commandText).toMatch(/server never blocks/i);
    expect(commandText).toMatch(/conversations author/i);
    expect(commandText).toMatch(/Studio reviews/i);
  });
});
