import { describe, expect, it } from "vitest";

import { expandNativeSpecCommandForAgent } from "./native-spec";

describe("expandNativeSpecCommandForAgent", () => {
  it("expands /spec into durable authoring instructions while preserving the request", () => {
    const expanded = expandNativeSpecCommandForAgent(
      "/spec Add a project health endpoint",
    );

    expect(expanded).toContain("Add a project health endpoint");
    expect(expanded).toContain("cctl spec create");
    expect(expanded).toContain("cctl spec draft");
    expect(expanded).toContain("cctl spec list");
    expect(expanded).toContain("Do not write or update `.kiro/specs/`");
  });

  it("instructs the atomic first-save create instead of a create-then-draft two-step", () => {
    const expanded = expandNativeSpecCommandForAgent("/spec");

    // The first save IS the creation: create carries the first element file.
    expect(expanded).toMatch(/cctl spec create[\s\S]{0,200}--file/);
    expect(expanded).toMatch(/first successful draft save/i);
    expect(expanded).not.toContain("then save");
    expect(expanded).toContain("slug_taken");
  });

  it("names the durable question verb so agents do not fall back to generic asks", () => {
    const expanded = expandNativeSpecCommandForAgent("/spec");

    // The rerun's exact R12 failure mode: the agent found no question verb in
    // the expansion, fell back to `cctl ask`, and left zero spec_questions.
    const flattened = expanded.replace(/\s+/g, " ");
    expect(flattened).toContain("cctl spec question");
    expect(flattened).toContain("cctl spec assume");
  });

  it("supports the argument-free command", () => {
    expect(expandNativeSpecCommandForAgent("/spec")).toContain(
      "Author a native Command Center spec",
    );
  });

  it.each(["/spec\tTabbed request", "/spec\nMultiline request"])(
    "accepts any whitespace between the command and request: %j",
    (prompt) => {
      const expanded = expandNativeSpecCommandForAgent(prompt);

      expect(expanded).toContain("Author a native Command Center spec");
      expect(expanded).toContain(prompt.slice("/spec".length).trim());
    },
  );

  it.each(["/specs", "/specified work", "please run /spec", "ordinary prompt"])(
    "leaves non-command input unchanged: %s",
    (prompt) => {
      expect(expandNativeSpecCommandForAgent(prompt)).toBe(prompt);
    },
  );
});
