import { describe, expect, it } from "vitest";
import {
  buildValidationCommandsSection,
  buildValidatorDeterministicChecksGuidance,
  loadValidationPromptRegistry,
  resolveValidationPromptSelections,
  type ValidationPromptRegistry,
} from "./validation-prompt-section";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";

const REGISTRY_COMMANDS = {
  typecheck: {
    command: { full: "scripts/validate/typecheck.sh" },
    cost: 2,
    pathArgs: "forbid" as const,
  },
  test: {
    command: {
      full: "scripts/validate/test-full-suite.sh",
      changed: "scripts/validate/test.sh",
    },
    cost: 4,
    pathArgs: "paths" as const,
  },
  format: {
    command: { full: "scripts/validate/format.sh" },
    cost: 1,
    pathArgs: "forbid" as const,
  },
};

const LOADED: ValidationPromptRegistry = {
  kind: "loaded",
  commands: REGISTRY_COMMANDS,
};

function contextConfig(
  overrides: Partial<
    Pick<GraphWorkflowResolvedContext, "scriptValidator" | "agentValidation">
  > = {},
): Pick<GraphWorkflowResolvedContext, "scriptValidator" | "agentValidation"> {
  return {
    scriptValidator: { commands: ["typecheck", "test"] },
    agentValidation: {
      implementer: {
        value: { mode: "all", except: ["format"] },
        source: "workflow",
        commands: ["typecheck", "test"],
      },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
        commands: [],
      },
    },
    ...overrides,
  };
}

describe("resolveValidationPromptSelections — frozen seed snapshot", () => {
  it("reads the implementer's enabled set from the frozen snapshot with registry costs", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig(),
      registry: LOADED,
    });
    expect(selections).toEqual({
      registry: "loaded",
      enabled: {
        kind: "commands",
        commands: [
          { name: "typecheck", cost: 2 },
          { name: "test", cost: 4 },
        ],
      },
      disabled: ["format"],
      scriptGate: { kind: "commands", commands: ["typecheck", "test"] },
    });
  });

  it("does not let a command registered after the freeze into a mode:all selection", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig(),
      registry: {
        kind: "loaded",
        commands: {
          ...REGISTRY_COMMANDS,
          build: {
            command: { full: "scripts/validate/build.sh" },
            cost: 6,
            pathArgs: "forbid" as const,
          },
        },
      },
    });
    // The frozen snapshot, not a prompt-time expansion, decides membership.
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: 2 },
        { name: "test", cost: 4 },
      ],
    });
    expect(selections.disabled).toEqual(["format", "build"]);
  });

  it("keeps a deregistered frozen command enabled, with its cost unknown", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig(),
      registry: {
        kind: "loaded",
        commands: {
          typecheck: REGISTRY_COMMANDS.typecheck,
          format: REGISTRY_COMMANDS.format,
        },
      },
    });
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: 2 },
        { name: "test", cost: null },
      ],
    });
    expect(selections.disabled).toEqual(["format"]);
  });

  it("gives the context validator its fail-closed frozen empty selection", () => {
    const selections = resolveValidationPromptSelections({
      role: "contextValidator",
      context: contextConfig(),
      registry: LOADED,
    });
    expect(selections.enabled).toEqual({ kind: "commands", commands: [] });
    expect(selections.disabled).toEqual(["typecheck", "test", "format"]);
  });

  it("keeps the frozen selection when the project registers nothing anymore", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig(),
      registry: { kind: "none" },
    });
    expect(selections.registry).toBe("none");
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: null },
        { name: "test", cost: null },
      ],
    });
    expect(selections.disabled).toEqual([]);
  });

  it("lists frozen names without costs when the registry is unavailable", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig(),
      registry: { kind: "unavailable" },
    });
    expect(selections.registry).toBe("unavailable");
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: null },
        { name: "test", cost: null },
      ],
    });
    expect(selections.disabled).toEqual([]);
  });
});

describe("resolveValidationPromptSelections — legacy pre-freeze rows", () => {
  const legacyAgentValidation = {
    implementer: {
      value: { mode: "all" as const, except: ["format"] },
      source: "workflow" as const,
    },
    contextValidator: {
      value: { mode: "only" as const, commands: ["test"] },
      source: "global" as const,
    },
  };

  it("uses the literal list for a legacy mode:only selector", () => {
    const selections = resolveValidationPromptSelections({
      role: "contextValidator",
      context: contextConfig({ agentValidation: legacyAgentValidation }),
      registry: LOADED,
    });
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [{ name: "test", cost: 4 }],
    });
    expect(selections.disabled).toEqual(["typecheck", "format"]);
  });

  it("expands a legacy mode:all selector at prompt time (pre-freeze rows only)", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig({ agentValidation: legacyAgentValidation }),
      registry: LOADED,
    });
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: 2 },
        { name: "test", cost: 4 },
      ],
    });
    expect(selections.disabled).toEqual(["format"]);
  });

  it("describes a legacy mode:all selector abstractly when the registry is unavailable", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig({ agentValidation: legacyAgentValidation }),
      registry: { kind: "unavailable" },
    });
    expect(selections.enabled).toEqual({
      kind: "legacy-all-except",
      except: ["format"],
    });
    expect(selections.disabled).toEqual([]);
  });

  it("falls back to seeded role defaults when the snapshot predates selectors", () => {
    const selections = resolveValidationPromptSelections({
      role: "implementer",
      context: contextConfig({ agentValidation: undefined }),
      registry: LOADED,
    });
    // Seeded implementer default is mode:"all" — every registered command.
    expect(selections.enabled).toEqual({
      kind: "commands",
      commands: [
        { name: "typecheck", cost: 2 },
        { name: "test", cost: 4 },
        { name: "format", cost: 1 },
      ],
    });
  });

  it("classifies the script gate from its command selection", () => {
    const gateOf = (
      scriptValidator: GraphWorkflowResolvedContext["scriptValidator"],
    ) =>
      resolveValidationPromptSelections({
        role: "implementer",
        context: contextConfig({ scriptValidator }),
        registry: LOADED,
      }).scriptGate;

    expect(gateOf({ commands: ["test"] })).toEqual({
      kind: "commands",
      commands: ["test"],
    });
    expect(gateOf({ commands: [] })).toEqual({ kind: "off" });
  });
});

describe("loadValidationPromptRegistry", () => {
  it("maps a read validation block to loaded", async () => {
    await expect(
      loadValidationPromptRegistry(async () => ({
        commands: REGISTRY_COMMANDS,
      })),
    ).resolves.toEqual({ kind: "loaded", commands: REGISTRY_COMMANDS });
  });

  it("maps a project without a validation block to none", async () => {
    await expect(
      loadValidationPromptRegistry(async () => undefined),
    ).resolves.toEqual({ kind: "none" });
  });

  it("maps a read failure to unavailable instead of throwing", async () => {
    await expect(
      loadValidationPromptRegistry(async () => {
        throw new Error("EACCES: CommandCenter.json");
      }),
    ).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("buildValidationCommandsSection", () => {
  it("lists enabled commands with costs, disabled commands, gate, and queue guidance", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "implementer",
        context: contextConfig(),
        registry: LOADED,
      }),
    );
    expect(section).toContain("## Validation Commands");
    expect(section).toContain("`cctl validate run <name>`");
    expect(section).toContain(
      "Enabled for you in this context: typecheck (cost 2), test (cost 4).",
    );
    expect(section).toContain("Disabled for you in this context: format.");
    expect(section).toContain(
      "Script gate for this context (runs separately when the context completes): typecheck, test.",
    );
    expect(section).toContain(
      "If a run is refused for capacity, continue other work and retry later, or re-run with `--wait` to queue for a slot.",
    );
  });

  it("renders the frozen script gate when the current project registry is empty", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "contextValidator",
        context: contextConfig(),
        registry: { kind: "none" },
      }),
    );
    expect(section).toContain("## Validation Commands");
    expect(section).toContain(
      "No validation commands are enabled for you in this context.",
    );
    expect(section).toContain(
      "Script gate for this context (runs separately when the context completes): typecheck, test.",
    );
  });

  it("reports explicit empty enabled, disabled, and script-gate state", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "contextValidator",
        context: contextConfig({
          scriptValidator: { commands: [] },
        }),
        registry: { kind: "none" },
      }),
    );
    expect(section).toContain("## Validation Commands");
    expect(section).toContain(
      "No validation commands are enabled for you in this context.",
    );
    expect(section).toContain(
      "No validation commands are disabled by policy in this context.",
    );
    expect(section).toContain("No script gate is selected for this context.");
  });

  it("states when a role has no enabled commands", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "contextValidator",
        context: contextConfig(),
        registry: LOADED,
      }),
    );
    expect(section).toContain(
      "No validation commands are enabled for you in this context.",
    );
  });

  it("renders an explicit notice instead of omitting the section when the registry is unavailable", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "implementer",
        context: contextConfig(),
        registry: { kind: "unavailable" },
      }),
    );
    expect(section).toContain("## Validation Commands");
    expect(section).toContain(
      "Enabled for you in this context: typecheck, test.",
    );
    expect(section).toContain("could not be read");
    expect(section).toContain(
      "If a run is refused for capacity, continue other work and retry later, or re-run with `--wait` to queue for a slot.",
    );
  });

  it("describes a legacy mode:all selection abstractly under an unavailable registry", () => {
    const section = buildValidationCommandsSection(
      resolveValidationPromptSelections({
        role: "implementer",
        context: contextConfig({
          agentValidation: {
            implementer: {
              value: { mode: "all", except: ["format"] },
              source: "workflow",
            },
            contextValidator: {
              value: { mode: "only", commands: [] },
              source: "global",
            },
          },
        }),
        registry: { kind: "unavailable" },
      }),
    );
    expect(section).toContain(
      "Enabled for you in this context: all registered commands except format.",
    );
    expect(section).toContain("could not be read");
  });
});

describe("buildValidatorDeterministicChecksGuidance", () => {
  it("names the actual script-gate commands when a selection exists", () => {
    const line = buildValidatorDeterministicChecksGuidance({
      kind: "commands",
      commands: ["typecheck", "test"],
    });
    expect(line).toContain("**Do not enforce deterministic checks.**");
    expect(line).toContain(
      "The script gate for this context runs `typecheck`, `test` separately",
    );
  });

  it("attributes an absent gate to workflow policy instead of another component", () => {
    const line = buildValidatorDeterministicChecksGuidance({ kind: "off" });
    expect(line).toContain("workflow policy disables it");
    expect(line).not.toContain("pre-merge validation script");
  });
});
