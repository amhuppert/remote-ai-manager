import { describe, it, expect } from "vitest";
import {
  KIRO_COMMAND_RE,
  parseKiroCommand,
  supportsAutoApprove,
  buildKiroPrompt,
  findKiroCommands,
} from "./kiro-commands";

describe("KIRO_COMMAND_RE", () => {
  it("matches a command name", () => {
    const match = "/kiro:spec-status".match(KIRO_COMMAND_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("/kiro:spec-status");
  });

  it("matches command name within text (does not capture args)", () => {
    const match = "Run /kiro:spec-design feature-name next".match(
      KIRO_COMMAND_RE,
    );
    expect(match).not.toBeNull();
    expect(match![0]).toBe("/kiro:spec-design");
  });

  it("matches validate-gap command", () => {
    const match = "/kiro:validate-gap".match(KIRO_COMMAND_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("/kiro:validate-gap");
  });

  it("does NOT match non-kiro commands", () => {
    expect("/commit".match(KIRO_COMMAND_RE)).toBeNull();
    expect("/help".match(KIRO_COMMAND_RE)).toBeNull();
  });

  it("does NOT match without leading slash", () => {
    expect("kiro:spec-design".match(KIRO_COMMAND_RE)).toBeNull();
  });
});

describe("findKiroCommands", () => {
  it("finds multiple commands in text", () => {
    const text =
      "Run /kiro:spec-design first, then /kiro:spec-tasks to continue.";
    const results = findKiroCommands(text);
    expect(results).toHaveLength(2);
    expect(results[0]!.commandName).toBe("/kiro:spec-design");
    expect(results[0]!.args).toBeNull();
    expect(results[1]!.commandName).toBe("/kiro:spec-tasks");
    expect(results[1]!.args).toBeNull();
  });

  it("returns empty array when no commands found", () => {
    expect(findKiroCommands("No commands here")).toEqual([]);
  });

  it("includes match indices", () => {
    const text = "Run /kiro:spec-status now";
    const results = findKiroCommands(text);
    expect(results).toHaveLength(1);
    expect(results[0]!.startIndex).toBe(4);
    expect(results[0]!.endIndex).toBe(21);
  });

  it("finds command at start of text", () => {
    const results = findKiroCommands("/kiro:spec-init is the first step");
    expect(results).toHaveLength(1);
    expect(results[0]!.commandName).toBe("/kiro:spec-init");
    expect(results[0]!.startIndex).toBe(0);
  });
});

describe("parseKiroCommand", () => {
  it("parses command with no args", () => {
    const result = parseKiroCommand("/kiro:spec-status");
    expect(result).toEqual({
      commandName: "/kiro:spec-status",
      args: null,
      fullText: "/kiro:spec-status",
    });
  });

  it("parses command with feature arg", () => {
    const result = parseKiroCommand("/kiro:spec-design feature-name");
    expect(result).toEqual({
      commandName: "/kiro:spec-design",
      args: "feature-name",
      fullText: "/kiro:spec-design feature-name",
    });
  });

  it("parses command with multiple args", () => {
    const result = parseKiroCommand("/kiro:spec-impl my-feat 1.1,2.3");
    expect(result).toEqual({
      commandName: "/kiro:spec-impl",
      args: "my-feat 1.1,2.3",
      fullText: "/kiro:spec-impl my-feat 1.1,2.3",
    });
  });

  it("strips trailing -y flag from args", () => {
    const result = parseKiroCommand("/kiro:spec-design my-feat -y");
    expect(result).toEqual({
      commandName: "/kiro:spec-design",
      args: "my-feat",
      fullText: "/kiro:spec-design my-feat -y",
    });
  });

  it("strips trailing --sequential flag from args", () => {
    const result = parseKiroCommand("/kiro:spec-impl my-feat --sequential");
    expect(result).toEqual({
      commandName: "/kiro:spec-impl",
      args: "my-feat",
      fullText: "/kiro:spec-impl my-feat --sequential",
    });
  });

  it("returns null for non-kiro input", () => {
    expect(parseKiroCommand("/commit")).toBeNull();
    expect(parseKiroCommand("hello world")).toBeNull();
  });

  it("handles whitespace trimming", () => {
    const result = parseKiroCommand("  /kiro:spec-design my-feat  ");
    expect(result).not.toBeNull();
    expect(result!.commandName).toBe("/kiro:spec-design");
    expect(result!.args).toBe("my-feat");
  });
});

describe("supportsAutoApprove", () => {
  it("returns true for spec-design", () => {
    expect(supportsAutoApprove("/kiro:spec-design")).toBe(true);
  });

  it("returns true for spec-tasks", () => {
    expect(supportsAutoApprove("/kiro:spec-tasks")).toBe(true);
  });

  it("returns true for spec-impl", () => {
    expect(supportsAutoApprove("/kiro:spec-impl")).toBe(true);
  });

  it("returns false for spec-requirements", () => {
    expect(supportsAutoApprove("/kiro:spec-requirements")).toBe(false);
  });

  it("returns false for spec-status", () => {
    expect(supportsAutoApprove("/kiro:spec-status")).toBe(false);
  });

  it("returns false for validate-gap", () => {
    expect(supportsAutoApprove("/kiro:validate-gap")).toBe(false);
  });
});

describe("buildKiroPrompt", () => {
  it("builds prompt with no args and no auto-approve", () => {
    expect(buildKiroPrompt("/kiro:spec-status", null, false)).toBe(
      "/kiro:spec-status",
    );
  });

  it("builds prompt with args and no auto-approve", () => {
    expect(buildKiroPrompt("/kiro:spec-design", "my-feat", false)).toBe(
      "/kiro:spec-design my-feat",
    );
  });

  it("builds prompt with args and auto-approve", () => {
    expect(buildKiroPrompt("/kiro:spec-design", "my-feat", true)).toBe(
      "/kiro:spec-design my-feat -y",
    );
  });

  it("builds prompt with no args and auto-approve", () => {
    expect(buildKiroPrompt("/kiro:spec-tasks", null, true)).toBe(
      "/kiro:spec-tasks -y",
    );
  });
});
