import { describe, it, expect } from "vitest";
import {
  getUnderstandObjectivePrompt,
  getWriteFocusDocumentPrompt,
} from "./templates";

describe("getUnderstandObjectivePrompt", () => {
  it("includes the objective in the prompt", () => {
    const prompt = getUnderstandObjectivePrompt("Build a REST API");
    expect(prompt).toContain("Build a REST API");
  });

  it("wraps the objective in an <objective> tag", () => {
    const prompt = getUnderstandObjectivePrompt("Test objective");
    expect(prompt).toContain("<objective>");
    expect(prompt).toContain("</objective>");
  });

  it("instructs not to write focus.md", () => {
    const prompt = getUnderstandObjectivePrompt("Any objective");
    expect(prompt).toContain("Do NOT write focus.md");
  });

  it("includes research and question steps", () => {
    const prompt = getUnderstandObjectivePrompt("Any objective");
    expect(prompt).toContain("Step 1: Research and Analysis");
    expect(prompt).toContain("Step 2: Ask Clarifying Questions");
    expect(prompt).toContain("AskUserQuestion");
  });

  it("instructs not to begin implementation", () => {
    const prompt = getUnderstandObjectivePrompt("Any objective");
    expect(prompt).toContain("Do NOT begin implementing");
  });

  it("includes command-name tag for transcript display", () => {
    const prompt = getUnderstandObjectivePrompt("Build a REST API");
    expect(prompt).toContain(
      "<command-name>focus:understand-objective</command-name>",
    );
  });

  it("includes command-args tag with the objective", () => {
    const prompt = getUnderstandObjectivePrompt("Build a REST API");
    expect(prompt).toContain("<command-args>Build a REST API</command-args>");
  });
});

describe("getWriteFocusDocumentPrompt", () => {
  it("instructs to write memory-bank/focus.md", () => {
    const prompt = getWriteFocusDocumentPrompt();
    expect(prompt).toContain("memory-bank/focus.md");
  });

  it("includes the focus document structure sections", () => {
    const prompt = getWriteFocusDocumentPrompt();
    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("## Detailed Requirements");
    expect(prompt).toContain("## Key Design Decisions");
    expect(prompt).toContain("## Implementation Approach");
    expect(prompt).toContain("## Relevant Patterns");
  });

  it("instructs not to begin implementation", () => {
    const prompt = getWriteFocusDocumentPrompt();
    expect(prompt).toContain("Do NOT begin any implementation work");
  });

  it("instructs to write and nothing else", () => {
    const prompt = getWriteFocusDocumentPrompt();
    expect(prompt).toContain("Write the file and nothing else");
  });

  it("includes command-name tag for transcript display", () => {
    const prompt = getWriteFocusDocumentPrompt();
    expect(prompt).toContain(
      "<command-name>focus:write-document</command-name>",
    );
  });
});
