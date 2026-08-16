import { maxDeclaredCost } from "@/lib/validation/cost-resolution";
import type { RepoValidationConfig } from "@/lib/validation/schemas";
import { DEFAULT_AGENT_VALIDATION_CONFIG } from "./config-schemas";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";
import { expandCommandSelector } from "./resolve-config";

// The generated per-context validation section for graph agent prompts
// (validation-concurrency §8): each lane sees its effective enabled commands
// with costs, the commands policy disables for it, and the script-gate
// selection. The ENABLED set is the frozen seed-time snapshot on the resolved
// context (design §6) — the current registry feeds only cost annotation and
// the disabled list, so a registry edit never changes what a running
// execution's prompt enables. §7 governs the validator's deterministic-checks
// paragraph: it may only claim another component runs a check when the
// selection says one actually will.

export type ValidationPromptRole = "implementer" | "contextValidator";

export interface ValidationPromptCommand {
  name: string;
  /**
   * Maximum configured reservation weight (a scope-aware declaration can charge
   * less for a narrowed run); null if the registry no longer lists it.
   */
  cost: number | null;
}

/**
 * The current project registry as an input, tri-state so a read FAILURE is
 * distinguishable from a project that registers nothing: the section must
 * surface an explicit "registry unavailable" notice rather than silently
 * omitting itself (the selection snapshot is still authoritative either way).
 */
export type ValidationPromptRegistry =
  | { kind: "loaded"; commands: RepoValidationConfig["commands"] }
  | { kind: "none" }
  | { kind: "unavailable" };

/**
 * A role's enabled selection. `commands` is the normal enumerated form.
 * `legacy-all-except` survives only for pre-freeze rows whose `mode:"all"`
 * selector needs a registry expansion that an unavailable registry cannot
 * provide — describable, but not enumerable.
 */
export type ValidationPromptEnabled =
  | { kind: "commands"; commands: ValidationPromptCommand[] }
  | { kind: "legacy-all-except"; except: string[] };

export type ValidationPromptScriptGate =
  | {
      kind: "commands";
      commands: string[];
    }
  | { kind: "off" };

export interface ValidationPromptSelections {
  registry: ValidationPromptRegistry["kind"];
  enabled: ValidationPromptEnabled;
  /** Currently registered commands this role's selection does not enable. */
  disabled: string[];
  scriptGate: ValidationPromptScriptGate;
}

export interface ResolveValidationPromptSelectionsInput {
  role: ValidationPromptRole;
  context: Pick<
    GraphWorkflowResolvedContext,
    "scriptValidator" | "agentValidation"
  >;
  registry: ValidationPromptRegistry;
}

/**
 * Fail-visible registry loading for the prompt builders: a project without a
 * `validation` block is `none`; a read failure is `unavailable`, never a
 * thrown error and never a silently omitted section.
 */
export async function loadValidationPromptRegistry(
  readRepoValidation: () => Promise<
    Pick<RepoValidationConfig, "commands"> | null | undefined
  >,
): Promise<ValidationPromptRegistry> {
  try {
    const validation = await readRepoValidation();
    return validation
      ? { kind: "loaded", commands: validation.commands }
      : { kind: "none" };
  } catch {
    return { kind: "unavailable" };
  }
}

export function resolveValidationPromptSelections(
  input: ResolveValidationPromptSelectionsInput,
): ValidationPromptSelections {
  const registryCommands =
    input.registry.kind === "loaded" ? input.registry.commands : {};
  const annotate = (name: string): ValidationPromptCommand => {
    const declared = registryCommands[name]?.cost;
    return {
      name,
      cost: declared === undefined ? null : maxDeclaredCost(declared),
    };
  };

  // Contexts resolved before the selector snapshot existed carry no
  // agentValidation; policy treats absence as the seeded defaults.
  const leaf =
    input.role === "implementer"
      ? input.context.agentValidation?.implementer
      : input.context.agentValidation?.contextValidator;
  const selector = leaf?.value ?? DEFAULT_AGENT_VALIDATION_CONFIG[input.role];

  let enabled: ValidationPromptEnabled;
  if (leaf?.commands !== undefined) {
    // The frozen seed-time (or live-edit) snapshot — authoritative, verbatim.
    // A name the registry has since dropped stays listed (cost unknown); a
    // name registered since never appears.
    enabled = { kind: "commands", commands: leaf.commands.map(annotate) };
  } else if (selector.mode === "only") {
    // Pre-freeze rows: a literal selection needs no registry to enumerate.
    enabled = { kind: "commands", commands: selector.commands.map(annotate) };
  } else if (input.registry.kind === "unavailable") {
    enabled = { kind: "legacy-all-except", except: [...selector.except] };
  } else {
    // Pre-freeze rows only: `mode:"all"` has no snapshot to read, so it
    // expands against the current registry at prompt time.
    enabled = {
      kind: "commands",
      commands: expandCommandSelector(
        selector,
        Object.keys(registryCommands),
      ).commands.map(annotate),
    };
  }

  const enabledNames = new Set(
    enabled.kind === "commands" ? enabled.commands.map((c) => c.name) : [],
  );
  const disabled =
    input.registry.kind === "loaded" && enabled.kind === "commands"
      ? Object.keys(registryCommands).filter((name) => !enabledNames.has(name))
      : [];

  const scriptValidator = input.context.scriptValidator;
  const scriptGate: ValidationPromptScriptGate =
    scriptValidator.commands.length > 0
      ? { kind: "commands", commands: [...scriptValidator.commands] }
      : { kind: "off" };

  return { registry: input.registry.kind, enabled, disabled, scriptGate };
}

function scriptGateLine(scriptGate: ValidationPromptScriptGate): string {
  switch (scriptGate.kind) {
    case "commands":
      return `Script gate for this context (runs separately when the context completes): ${scriptGate.commands.join(", ")}.`;
    case "off":
      return "No script gate is selected for this context.";
  }
}

function formatEnabledCommand(command: ValidationPromptCommand): string {
  return command.cost !== null
    ? `${command.name} (cost ${command.cost})`
    : command.name;
}

function enabledLine(enabled: ValidationPromptEnabled): string {
  if (enabled.kind === "legacy-all-except") {
    return enabled.except.length > 0
      ? `Enabled for you in this context: all registered commands except ${enabled.except.join(", ")}.`
      : "Enabled for you in this context: all registered commands.";
  }
  return enabled.commands.length > 0
    ? `Enabled for you in this context: ${enabled.commands.map(formatEnabledCommand).join(", ")}.`
    : "No validation commands are enabled for you in this context.";
}

/**
 * The `## Validation Commands` prompt section. Always renders the complete
 * frozen state, including explicit empty enabled/disabled lists and an absent
 * script gate. An UNAVAILABLE registry adds a notice in place of the costs and
 * policy-disabled list it cannot compute.
 */
export function buildValidationCommandsSection(
  selections: ValidationPromptSelections,
): string {
  const lines = [
    "## Validation Commands",
    "Run registered validation only through `cctl validate run <name>`. Runs default to changed scope; use `--scope full` when full-project evidence is required. A full-only command falls back automatically. Do not invoke test runners, type checkers, linters, formatters, or builds directly, and never bypass the wrapper to avoid a queue or an execution-context policy.",
    enabledLine(selections.enabled),
  ];
  if (selections.disabled.length > 0) {
    lines.push(
      `Disabled for you in this context: ${selections.disabled.join(", ")}.`,
    );
  } else if (selections.registry !== "unavailable") {
    lines.push(
      "No validation commands are disabled by policy in this context.",
    );
  }
  if (selections.registry === "unavailable") {
    lines.push(
      "The project's validation registry could not be read this turn; command costs and the policy-disabled list are unavailable, but the enabled selection above is authoritative.",
    );
  }
  lines.push(
    scriptGateLine(selections.scriptGate),
    "If a run is refused for capacity, continue other work and retry later, or re-run with `--wait` to queue for a slot.",
  );
  return lines.join("\n");
}

/**
 * The context validator's "do not enforce deterministic checks" bullet,
 * selection-aware per design §7: it names the actual script-gate commands when
 * a selection exists and otherwise attributes the absence to workflow policy
 * instead of claiming another component runs it.
 */
export function buildValidatorDeterministicChecksGuidance(
  scriptGate: ValidationPromptScriptGate,
): string {
  const base =
    "- **Do not enforce deterministic checks.** You must not fail the context for failing tests, type errors, lint violations, build failures, or compile errors.";
  const close = "Focus on judgments that only a reviewing agent can make.";
  switch (scriptGate.kind) {
    case "commands":
      return `${base} The script gate for this context runs ${scriptGate.commands
        .map((name) => `\`${name}\``)
        .join(
          ", ",
        )} separately; those checks are not your responsibility. ${close}`;
    case "off":
      return `${base} No script gate is selected for this context — where such a check does not run, workflow policy disables it rather than delegating it to you. Do not attempt to run those checks yourself. ${close}`;
  }
}
