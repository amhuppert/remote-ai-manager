import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./commands";

describe("parseFrontmatter", () => {
  it("parses valid frontmatter block", () => {
    const content = `---
description: Initialize a spec
argument-hint: <project-description>
---
Body content here.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("Initialize a spec");
    expect(result.fields["argument-hint"]).toBe("<project-description>");
    expect(result.body).toBe("Body content here.");
  });

  it("returns empty fields when no frontmatter", () => {
    const content = "Just body content.";
    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Just body content.");
  });

  it("handles empty content", () => {
    const result = parseFrontmatter("");
    expect(result.fields).toEqual({});
    expect(result.body).toBe("");
  });

  it("handles frontmatter with no closing delimiter", () => {
    const content = `---
description: No closing`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe(content);
  });

  it("strips surrounding quotes from values", () => {
    const content = `---
description: "A quoted value"
name: 'single quoted'
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.fields["description"]).toBe("A quoted value");
    expect(result.fields["name"]).toBe("single quoted");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
Body only.`;

    const result = parseFrontmatter(content);
    expect(result.fields).toEqual({});
    expect(result.body).toBe("Body only.");
  });
});
