import { describe, expect, it } from "vitest";

import {
  translateCodexCapabilities,
  type CodexCapabilityResolvedInput,
} from "./codex-translator";

function input(
  partial: Partial<CodexCapabilityResolvedInput>,
): CodexCapabilityResolvedInput {
  return {
    skills: partial.skills ?? [],
    plugins: partial.plugins ?? [],
  };
}

describe("Codex capability translator", () => {
  it("returns empty config, no diagnostics, and no emitted cascades when no skills or plugins are present", () => {
    const result = translateCodexCapabilities(input({}));
    expect(result.config).toEqual({});
    expect(result.diagnostics).toEqual([]);
    expect(result.emittedCascadeKinds).toEqual([]);
    expect(result.applySemantics).toBe("next-turn");
  });

  it("emits a single enabled skill into skills.config[]", () => {
    const result = translateCodexCapabilities(
      input({
        skills: [
          {
            itemId: "foo",
            name: "foo",
            enabled: true,
            sourcePath: "/skills/foo",
          },
        ],
      }),
    );

    expect(result.config).toEqual({
      skills: { config: [{ enabled: true, name: "foo" }] },
    });
    expect(result.emittedCascadeKinds).toEqual(["codex-skills"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("emits a single disabled skill (not omitted) so the override carries the disable", () => {
    const result = translateCodexCapabilities(
      input({
        skills: [
          {
            itemId: "foo",
            name: "foo",
            enabled: false,
            sourcePath: "/skills/foo",
          },
        ],
      }),
    );

    expect(result.config).toEqual({
      skills: { config: [{ enabled: false, name: "foo" }] },
    });
    expect(result.emittedCascadeKinds).toEqual(["codex-skills"]);
  });

  it("emits a mix of enabled and disabled skills in input order", () => {
    const result = translateCodexCapabilities(
      input({
        skills: [
          {
            itemId: "spec-init",
            name: "spec-init",
            enabled: true,
            sourcePath: "/skills/spec-init",
          },
          {
            itemId: "spec-tasks",
            name: "spec-tasks",
            enabled: false,
            sourcePath: "/skills/spec-tasks",
          },
          {
            itemId: "spec-design",
            name: "spec-design",
            enabled: true,
            sourcePath: "/skills/spec-design",
          },
        ],
      }),
    );

    expect(result.config.skills?.config).toEqual([
      { enabled: true, name: "spec-init" },
      { enabled: false, name: "spec-tasks" },
      { enabled: true, name: "spec-design" },
    ]);
    expect(result.emittedCascadeKinds).toEqual(["codex-skills"]);
  });

  it("emits a single enabled plugin into plugins.NAME", () => {
    const result = translateCodexCapabilities(
      input({
        plugins: [{ itemId: "oh-my-codex", enabled: true }],
      }),
    );

    expect(result.config).toEqual({
      plugins: { "oh-my-codex": { enabled: true } },
    });
    expect(result.emittedCascadeKinds).toEqual(["codex-plugins"]);
  });

  it("emits a single disabled plugin (not omitted)", () => {
    const result = translateCodexCapabilities(
      input({
        plugins: [{ itemId: "oh-my-codex", enabled: false }],
      }),
    );

    expect(result.config).toEqual({
      plugins: { "oh-my-codex": { enabled: false } },
    });
    expect(result.emittedCascadeKinds).toEqual(["codex-plugins"]);
  });

  it("preserves an @scoped plugin id verbatim as the plugins record key", () => {
    const result = translateCodexCapabilities(
      input({
        plugins: [{ itemId: "oh-my-codex@oh-my-codex-local", enabled: false }],
      }),
    );

    expect(result.config.plugins).toEqual({
      "oh-my-codex@oh-my-codex-local": { enabled: false },
    });
    expect(result.emittedCascadeKinds).toEqual(["codex-plugins"]);
  });

  it("emits both cascades together when both skills and plugins are present", () => {
    const result = translateCodexCapabilities(
      input({
        skills: [
          {
            itemId: "spec-init",
            name: "spec-init",
            enabled: true,
            sourcePath: "/skills/spec-init",
          },
        ],
        plugins: [{ itemId: "oh-my-codex", enabled: true }],
      }),
    );

    expect(result.config.skills?.config).toEqual([
      { enabled: true, name: "spec-init" },
    ]);
    expect(result.config.plugins).toEqual({
      "oh-my-codex": { enabled: true },
    });
    expect([...result.emittedCascadeKinds].sort()).toEqual([
      "codex-plugins",
      "codex-skills",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.applySemantics).toBe("next-turn");
  });
});
