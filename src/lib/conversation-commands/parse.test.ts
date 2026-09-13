import { describe, expect, it } from "vitest";

import {
  hasCollabPrefix,
  parseConversationCommand,
  stripCollabPrefix,
} from "./parse";

describe("parseConversationCommand", () => {
  it("parses exact /commit with empty hint", () => {
    expect(parseConversationCommand("/commit")).toEqual({
      command: "commit",
      hint: "",
    });
  });

  it("parses exact /merge with empty hint", () => {
    expect(parseConversationCommand("/merge")).toEqual({
      command: "merge",
      hint: "",
    });
  });

  it("extracts the skip-marking option from merge message guidance", () => {
    expect(
      parseConversationCommand("/merge --no-mark-merged\nship the parser"),
    ).toEqual({
      command: "merge",
      hint: "ship the parser",
      skipMarkMerged: true,
    });
    expect(parseConversationCommand("/merge --no-mark-merged")).toEqual({
      command: "merge",
      hint: "",
      skipMarkMerged: true,
    });
    expect(
      parseConversationCommand("/merge describe --no-mark-merged"),
    ).toEqual({
      command: "merge",
      hint: "describe --no-mark-merged",
    });
  });

  it("parses /commit with trailing hint, trimmed", () => {
    expect(
      parseConversationCommand("/commit focus on the parser refactor"),
    ).toEqual({
      command: "commit",
      hint: "focus on the parser refactor",
    });
  });

  it("parses /merge with trailing hint, trimmed", () => {
    expect(
      parseConversationCommand("/merge emphasize the schema change  "),
    ).toEqual({
      command: "merge",
      hint: "emphasize the schema change",
    });
  });

  it("parses exact /align with empty hint", () => {
    expect(parseConversationCommand("/align")).toEqual({
      command: "align",
      hint: "",
    });
  });

  it("parses /align with trailing guidance, trimmed", () => {
    expect(
      parseConversationCommand("/align focus on the API boundaries  "),
    ).toEqual({
      command: "align",
      hint: "focus on the API boundaries",
    });
  });

  it("parses exact /ticket with empty hint", () => {
    expect(parseConversationCommand("/ticket")).toEqual({
      command: "ticket",
      hint: "",
    });
  });

  it("parses /ticket with trailing hint, trimmed", () => {
    expect(
      parseConversationCommand("/ticket capture the flaky retry bug  "),
    ).toEqual({
      command: "ticket",
      hint: "capture the flaky retry bug",
    });
  });

  it("tolerates leading whitespace before the command", () => {
    expect(parseConversationCommand("   /commit")).toEqual({
      command: "commit",
      hint: "",
    });
    expect(parseConversationCommand("\n\t /merge keep it short")).toEqual({
      command: "merge",
      hint: "keep it short",
    });
  });

  it("treats command followed by newline as command + hint", () => {
    expect(parseConversationCommand("/commit\nmention the bug fix")).toEqual({
      command: "commit",
      hint: "mention the bug fix",
    });
  });

  it("returns null for near-miss prefixes like /committed", () => {
    expect(parseConversationCommand("/committed")).toBeNull();
    expect(parseConversationCommand("/merged")).toBeNull();
    expect(parseConversationCommand("/commitx now")).toBeNull();
    expect(parseConversationCommand("/aligning")).toBeNull();
    expect(parseConversationCommand("/aligned the bars")).toBeNull();
  });

  it("returns null for mid-message occurrences", () => {
    expect(parseConversationCommand("please run /commit for me")).toBeNull();
    expect(parseConversationCommand("the /merge flow is broken")).toBeNull();
  });

  it("returns null for plain text and other commands", () => {
    expect(parseConversationCommand("hello world")).toBeNull();
    expect(parseConversationCommand("/collab do a thing")).toBeNull();
    expect(parseConversationCommand("")).toBeNull();
    expect(parseConversationCommand("   ")).toBeNull();
  });
});

describe("hasCollabPrefix", () => {
  it("returns true for exact /collab", () => {
    expect(hasCollabPrefix("/collab")).toBe(true);
  });

  it("returns true for /collab with a trailing space and brief", () => {
    expect(hasCollabPrefix("/collab fix the bug")).toBe(true);
  });

  it("returns true when the brief starts on the next line", () => {
    expect(hasCollabPrefix("/collab\nfix the bug")).toBe(true);
    expect(hasCollabPrefix("/collab\r\nfix the bug")).toBe(true);
    expect(hasCollabPrefix("/collab\tfix the bug")).toBe(true);
  });

  it("returns true with leading whitespace before /collab", () => {
    expect(hasCollabPrefix("  /collab brief")).toBe(true);
  });

  it("returns false for prompts not starting with /collab", () => {
    expect(hasCollabPrefix("hello /collab")).toBe(false);
    expect(hasCollabPrefix("/collaborate")).toBe(false);
    expect(hasCollabPrefix("/collab-mode go")).toBe(false);
  });
});

describe("stripCollabPrefix", () => {
  it("returns empty string for exact /collab", () => {
    expect(stripCollabPrefix("/collab")).toBe("");
  });

  it("strips /collab and the following space", () => {
    expect(stripCollabPrefix("/collab fix the bug")).toBe("fix the bug");
  });

  it("strips /collab and the following newline", () => {
    expect(stripCollabPrefix("/collab\nfix the bug")).toBe("fix the bug");
    expect(stripCollabPrefix("/collab\n\nfix the bug")).toBe("\nfix the bug");
  });

  it("preserves whitespace within the brief", () => {
    expect(stripCollabPrefix("/collab  multi  word")).toBe(" multi  word");
  });

  it("returns the input when it is not a /collab invocation", () => {
    expect(stripCollabPrefix("just a prompt")).toBe("just a prompt");
  });
});
