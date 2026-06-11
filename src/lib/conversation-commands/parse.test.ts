import { describe, expect, it } from "vitest";

import { parseConversationCommand } from "./parse";

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
