import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("skill frontmatter", () => {
  it("ignores comment lines containing colons without creating fields", () => {
    expect(
      parseFrontmatter(
        "---\n# description: not a field\nname: demo\n  # model: not a field\ndescription: Useful skill\n---\nInstructions.",
      ),
    ).toEqual({
      fields: { name: "demo", description: "Useful skill" },
      body: "Instructions.",
    });
  });

  it("preserves hashes in quoted values and indented block content", () => {
    expect(
      parseFrontmatter(
        "---\nname: '# demo: skill'\ndescription: |\n  # literal: heading\n  Use #tag: here.\n# model: not a field\ntitle: \"A #tag: title\"\n---\nInstructions.",
      ),
    ).toEqual({
      fields: {
        name: "# demo: skill",
        description: "# literal: heading\nUse #tag: here.",
        title: "A #tag: title",
      },
      body: "Instructions.",
    });
  });

  it("folds multiline descriptions without treating their colons as fields", () => {
    expect(
      parseFrontmatter(
        "---\nname: demo\ndescription: >-\n  Use for CC actions:\n  ask questions and run checks.\n---\nRead the reference.",
      ),
    ).toEqual({
      fields: {
        name: "demo",
        description: "Use for CC actions: ask questions and run checks.",
      },
      body: "Read the reference.",
    });
  });
});
