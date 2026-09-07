import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("skill frontmatter", () => {
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
