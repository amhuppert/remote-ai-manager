"use client";

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type {
  GraphWorkflowCommandSelector,
  GraphWorkflowLaneMergeCommandSelector,
  GraphWorkflowLaneMergeValidationConfig,
} from "@/lib/workflow-graph/config-schemas";
import { isConfigLocked } from "./affordance";
import type { ConfigCascadeEditor } from "./cascade-editor";
import type { ConfigPath } from "./config-cascade";
import { ConfigChecklist, type ConfigChecklistOption } from "./ConfigControls";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import { inheritedTierChip } from "./row-provenance";

/**
 * The three gates that select validation COMMANDS rather than agents (Config
 * Panel `scriptRows()`, `agentvalRows()`, `laneMergeRows()`).
 *
 * All three offer the same thing — a checklist over the project's registered
 * commands — and differ only in what a selection means and at which granularity
 * it is stored: the script gate is one block, agent validation is two
 * independent roles, and lane-merge validation is two independent fields that
 * exist at the workflow tier alone.
 *
 * The checklist is fed from the LIVE registry the host passes down, never from
 * a list this module keeps. An absent registry is a registry that could not be
 * read, which is not the same claim as a project with no commands — so it says
 * so instead of rendering an empty list the reader would take as complete.
 */

const SCRIPT_HINT =
  "Runs before agent validation. An empty selection disables the gate.";

const REGISTRY_UNAVAILABLE =
  "This project's registered validation commands could not be read, so the list is unknown rather than empty. The current selection is preserved.";

const REGISTRY_EMPTY =
  "This project registers no validation commands, so there is nothing for this gate to run.";

const AGENT_VALIDATION_NOTE =
  "The two roles resolve independently. Editing one leaves the other inheriting from its own tier.";

const LANE_MERGE_NOTE =
  "Validates parallel-lane merges at the shared fan-in. Contexts cannot override it — it does not appear on Context scope.";

const LANE_MERGE_HINT: Record<
  GraphWorkflowLaneMergeValidationConfig["strategy"],
  string
> = {
  "final-only": "Validates only the last merge of a join series.",
  "every-merge": "Validates every lane merge in a join series.",
};

const LANE_MERGE_STRATEGIES: readonly GraphWorkflowLaneMergeValidationConfig["strategy"][] =
  ["final-only", "every-merge"];

const COMMAND_SOURCE_LABEL: Record<
  GraphWorkflowLaneMergeCommandSelector["mode"],
  string
> = {
  project: "Project default",
  only: "Custom list",
};

const COMMAND_SOURCES: readonly GraphWorkflowLaneMergeCommandSelector["mode"][] =
  ["project", "only"];

const AGENT_VALIDATION_MODE_LABEL: Record<
  GraphWorkflowCommandSelector["mode"],
  string
> = {
  all: "All except",
  only: "Only",
};

const AGENT_VALIDATION_MODES: readonly GraphWorkflowCommandSelector["mode"][] =
  ["all", "only"];

/** Every role path, so a screen can name one without widening to `ConfigPath`. */
type AgentValidationPath = Extract<ConfigPath, `agentValidation.${string}`>;

const AGENT_VALIDATION_ROLES: readonly {
  path: AgentValidationPath;
  label: string;
  rowId: string;
}[] = [
  {
    path: "agentValidation.implementer",
    label: "Implementer",
    rowId: "agentval-implementer",
  },
  {
    path: "agentValidation.contextValidator",
    label: "Context validator",
    rowId: "agentval-contextValidator",
  },
];

/** The names a selector currently lists, whichever side of the mode it is on. */
function selectedNames(
  selector: GraphWorkflowCommandSelector,
): readonly string[] {
  return selector.mode === "all" ? selector.except : selector.commands;
}

function withNames(
  selector: GraphWorkflowCommandSelector,
  names: string[],
): GraphWorkflowCommandSelector {
  return selector.mode === "all"
    ? { mode: "all", except: names }
    : { mode: "only", commands: names };
}

function toggleName(
  names: readonly string[],
  name: string,
  checked: boolean,
): string[] {
  if (checked) return names.includes(name) ? [...names] : [...names, name];
  return names.filter((entry) => entry !== name);
}

/** What each mode plus its current list actually permits, said outright. */
function agentValidationHint(selector: GraphWorkflowCommandSelector): string {
  if (selector.mode === "all") {
    return selector.except.length === 0
      ? "Every registered validation command is allowed, including future registrations."
      : "Every registered command is allowed except the listed names.";
  }
  return selector.commands.length === 0
    ? "No validation commands are allowed."
    : "Only the listed commands are allowed.";
}

function laneMergeCommandsHint(
  selector: GraphWorkflowLaneMergeCommandSelector,
): string {
  if (selector.mode === "project") {
    return "Uses the project's lane-merge command list when configured, else its pre-merge list — resolved at merge submission.";
  }
  return selector.commands.length === 0
    ? "Empty list — lane-merge validation is disabled."
    : "Runs only the listed commands, in order.";
}

/** `cost 2 — ESLint over the changed files`, from the registry's own summary. */
function commandDescription(command: ValidationCommandSummary): string {
  return command.description === undefined
    ? `cost ${command.cost}`
    : `cost ${command.cost} — ${command.description}`;
}

/**
 * The registry checklist, or the reason there is none.
 *
 * `undefined` and `[]` are different claims and read differently: one is a
 * registry that could not be read, the other a project that registers nothing.
 */
function CommandChecklist({
  commands,
  selected,
  onToggle,
  disabled,
  /** Disambiguates two checklists on one screen for a screen reader. */
  nameSuffix,
}: {
  commands: readonly ValidationCommandSummary[] | undefined;
  selected: readonly string[];
  onToggle: (name: string, checked: boolean) => void;
  disabled: boolean;
  nameSuffix?: string;
}): React.JSX.Element {
  if (commands === undefined) {
    return (
      <p className="m-0 font-mono text-[0.7rem] leading-[1.5] text-amber">
        {REGISTRY_UNAVAILABLE}
      </p>
    );
  }
  if (commands.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
        {REGISTRY_EMPTY}
      </p>
    );
  }

  const options: ConfigChecklistOption[] = commands.map((command) => ({
    id: command.name,
    label: command.name,
    description: commandDescription(command),
    ...(nameSuffix === undefined
      ? {}
      : { ariaLabel: `${command.name} ${nameSuffix}` }),
    checked: selected.includes(command.name),
    onToggle: (next) => onToggle(command.name, next),
  }));

  return <ConfigChecklist options={options} disabled={disabled} />;
}

export function ScriptValidatorScreen({
  editor,
}: {
  editor: ConfigCascadeEditor;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const commands = cascade.resolve("scriptValidator").value.commands;
  const provenance = cascade.provenance("scriptValidator");

  return (
    <ConfigRowGroup label="Commands">
      <ConfigControlRow
        rowId="script-commands"
        label="Commands"
        hint={SCRIPT_HINT}
        provenance={provenance}
        disabled={locked}
        onReset={() => editor.onEdit(cascade.reset("scriptValidator"))}
      >
        <CommandChecklist
          commands={editor.validationCommands}
          selected={commands}
          disabled={locked}
          onToggle={(name, checked) =>
            editor.onEdit(
              cascade.set("scriptValidator", {
                commands: toggleName(commands, name, checked),
              }),
            )
          }
        />
      </ConfigControlRow>
    </ConfigRowGroup>
  );
}

function AgentValidationRole({
  editor,
  path,
  label,
  rowId,
}: {
  editor: ConfigCascadeEditor;
  path: AgentValidationPath;
  label: string;
  rowId: string;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const selector = cascade.resolve(path).value;
  const provenance = cascade.provenance(path);
  const inherited = inheritedTierChip(provenance);

  return (
    <ConfigRowGroup
      label={label}
      {...(inherited === null ? {} : { tier: inherited })}
    >
      <ConfigControlRow
        rowId={`${rowId}-mode`}
        label="Mode"
        hint={agentValidationHint(selector)}
        provenance={provenance}
        disabled={locked}
        onReset={() => editor.onEdit(cascade.reset(path))}
        control={
          <SegmentedControl
            aria-label={`Command mode for the ${label.toLowerCase()}`}
            value={selector.mode}
            disabled={locked}
            onValueChange={(next) => {
              if (next === selector.mode) return;
              // Switching sides starts from an empty list: the names meant the
              // opposite thing under the previous mode, so carrying them over
              // would invert what the author selected.
              editor.onEdit(
                cascade.set(
                  path,
                  next === "all"
                    ? { mode: "all", except: [] }
                    : { mode: "only", commands: [] },
                ),
              );
            }}
          >
            {AGENT_VALIDATION_MODES.map((mode) => (
              <SegmentedControlItem key={mode} value={mode}>
                {AGENT_VALIDATION_MODE_LABEL[mode]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        }
      />
      <ConfigControlRow
        rowId={`${rowId}-commands`}
        label={selector.mode === "all" ? "Exceptions" : "Allowed commands"}
        disabled={locked}
      >
        <CommandChecklist
          commands={editor.validationCommands}
          selected={selectedNames(selector)}
          disabled={locked}
          nameSuffix={`for the ${label.toLowerCase()}`}
          onToggle={(name, checked) =>
            editor.onEdit(
              cascade.set(
                path,
                withNames(
                  selector,
                  toggleName(selectedNames(selector), name, checked),
                ),
              ),
            )
          }
        />
      </ConfigControlRow>
    </ConfigRowGroup>
  );
}

export function AgentValidationScreen({
  editor,
}: {
  editor: ConfigCascadeEditor;
}): React.JSX.Element {
  return (
    <>
      <ConfigRowGroup>
        <ConfigControlRow
          rowId="agentval-note"
          label="Per-role cascade"
          hint={AGENT_VALIDATION_NOTE}
        />
      </ConfigRowGroup>
      {AGENT_VALIDATION_ROLES.map((role) => (
        <AgentValidationRole
          key={role.path}
          editor={editor}
          path={role.path}
          label={role.label}
          rowId={role.rowId}
        />
      ))}
    </>
  );
}

export function LaneMergeValidationScreen({
  editor,
}: {
  editor: ConfigCascadeEditor;
}): React.JSX.Element {
  const { cascade } = editor;
  const locked = isConfigLocked(editor.affordance);
  const strategy = cascade.resolve("laneMergeValidation.strategy").value;
  const commands = cascade.resolve("laneMergeValidation.commands").value;

  return (
    <>
      <ConfigRowGroup>
        <ConfigControlRow
          rowId="lanemerge-note"
          label="Workflow scope only"
          hint={LANE_MERGE_NOTE}
        />
      </ConfigRowGroup>

      <ConfigRowGroup label="Strategy">
        <ConfigControlRow
          rowId="lanemerge-strategy"
          label="Strategy"
          hint={LANE_MERGE_HINT[strategy]}
          provenance={cascade.provenance("laneMergeValidation.strategy")}
          disabled={locked}
          onReset={() =>
            editor.onEdit(cascade.reset("laneMergeValidation.strategy"))
          }
        >
          <SegmentedControl
            aria-label="Lane-merge validation strategy"
            value={strategy}
            disabled={locked}
            layoutClassName="w-full"
            onValueChange={(next) => {
              const chosen = LANE_MERGE_STRATEGIES.find(
                (option) => option === next,
              );
              if (chosen === undefined) return;
              editor.onEdit(
                cascade.set("laneMergeValidation.strategy", chosen),
              );
            }}
          >
            {LANE_MERGE_STRATEGIES.map((option) => (
              <SegmentedControlItem
                key={option}
                value={option}
                layoutClassName="flex-1"
              >
                {option}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </ConfigControlRow>
      </ConfigRowGroup>

      <ConfigRowGroup label="Commands">
        <ConfigControlRow
          rowId="lanemerge-source"
          label="Command source"
          hint={laneMergeCommandsHint(commands)}
          provenance={cascade.provenance("laneMergeValidation.commands")}
          disabled={locked}
          onReset={() =>
            editor.onEdit(cascade.reset("laneMergeValidation.commands"))
          }
        >
          <SegmentedControl
            aria-label="Lane-merge command source"
            value={commands.mode}
            disabled={locked}
            layoutClassName="w-full"
            onValueChange={(next) => {
              if (next === commands.mode) return;
              editor.onEdit(
                cascade.set(
                  "laneMergeValidation.commands",
                  next === "project"
                    ? { mode: "project" }
                    : { mode: "only", commands: [] },
                ),
              );
            }}
          >
            {COMMAND_SOURCES.map((option) => (
              <SegmentedControlItem
                key={option}
                value={option}
                layoutClassName="flex-1"
              >
                {COMMAND_SOURCE_LABEL[option]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </ConfigControlRow>
        {commands.mode === "only" ? (
          <ConfigControlRow
            rowId="lanemerge-commands"
            label="Command list"
            disabled={locked}
          >
            <CommandChecklist
              commands={editor.validationCommands}
              selected={commands.commands}
              disabled={locked}
              nameSuffix="for lane merges"
              onToggle={(name, checked) =>
                editor.onEdit(
                  cascade.set("laneMergeValidation.commands", {
                    mode: "only",
                    commands: toggleName(commands.commands, name, checked),
                  }),
                )
              }
            />
          </ConfigControlRow>
        ) : null}
      </ConfigRowGroup>
    </>
  );
}
