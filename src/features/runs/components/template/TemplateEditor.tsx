"use client";

import { useMemo, useState } from "react";
import { MultilineInput } from "@/components/MultilineInput";
import {
  BranchIcon,
  CloseIcon,
  DocumentIcon,
  PlusIcon,
} from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import type { CascadedSettings } from "@/lib/config/settings-cascade";
import type {
  RunTemplateContent,
  RunTemplateContext,
  RunTemplateRecord,
} from "@/lib/run-templates/document";
import type { RunTemplateSummary } from "@/lib/run-templates/schemas";
import type { RunTemplateTier } from "@/lib/runs/schemas";
import type { RunSettingKey, RunSettings } from "@/lib/runs/settings";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";
import { cn } from "@/lib/ui/cn";
import {
  DiagramIcon,
  ListIcon,
  LoopIcon,
  PlayIcon,
} from "@/components/runs/icons";
import {
  TEMPLATE_PART,
  changeCounts,
  contentOf,
  contextSettings,
  draftProblems,
  editContext,
  minutesOf,
  resetContextSetting,
  resetDefault,
  setContextSetting,
  setDefault,
  setLaneChecks,
  templateSettings,
  timeoutMsOf,
  type DraftProblem,
} from "../../template-model";
import { seatOf } from "../../seat-model";
import {
  contextTitle,
  dependenciesOf,
  loopOf,
  templateDiagram,
  untitledName,
} from "../../template-structure";
import { RunDiagram } from "../RunDiagram";
import {
  ChecksEditor,
  FIELD,
  FieldSection,
  INPUT,
  ListEditor,
  NumberField,
  ProfileField,
  ReviewersEditor,
  SeatFields,
  SettingRow,
  TEXTAREA,
  TierBadge,
  type TemplateEditorOptions,
} from "./fields";

export type { TemplateEditorOptions } from "./fields";

/** How a save ended: stored, or refused because someone saved a newer revision first. */
export type TemplateSaveResult =
  | { kind: "saved"; template: RunTemplateRecord }
  | { kind: "conflict" };

export interface TemplateEditorActions {
  onSelectTemplate(template: RunTemplateSummary): void;
  /** Read the template again; the editor adopts it after an explicit discard confirmation. */
  onReload(): RunTemplateRecord | Promise<RunTemplateRecord>;
  /** Save the authored content at the revision it was edited from. Any other refusal throws. */
  onSave(
    content: RunTemplateContent,
    baseRevision: number,
  ): TemplateSaveResult | Promise<TemplateSaveResult>;
  /** Launch the saved revision the editor shows. */
  onLaunch(template: RunTemplateRecord): void;
}

type View = "edit" | "diagram";

/** An output schema typed in the editor: committed to the draft only once it is a schema the server accepts. */
function schemaTextOutcome(
  text: string,
):
  | { ok: true; schema: Record<string, unknown> | null }
  | { ok: false; message: string } {
  if (text.trim() === "") return { ok: true, schema: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Not valid JSON",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, message: "An output schema is a JSON object" };
  const issue = validateOutputSchemaDeclaration(parsed)[0];
  if (issue !== undefined)
    return { ok: false, message: `${issue.path}: ${issue.message}` };
  return { ok: true, schema: Object.fromEntries(Object.entries(parsed)) };
}

function schemaText(context: RunTemplateContext): string {
  return context.outputSchema === undefined
    ? ""
    : JSON.stringify(context.outputSchema, null, 2);
}

function TemplatesRail({
  templates,
  selectedId,
  selectedTier,
  disabled,
  onSelect,
}: {
  templates: readonly RunTemplateSummary[];
  selectedId: string;
  selectedTier: RunTemplateTier;
  disabled: boolean;
  onSelect(template: RunTemplateSummary): void;
}) {
  const tiers: Array<{ tier: RunTemplateTier; label: string }> = [
    { tier: "project", label: "This project" },
    { tier: "global", label: "Every project" },
  ];
  return (
    <nav aria-label="Run templates" className="flex flex-col gap-xl">
      <span className="px-md font-display text-[1.05rem] font-bold text-text-primary">
        Run templates
      </span>
      {tiers.map(({ tier, label }) => {
        const listed = templates.filter((template) => template.tier === tier);
        if (listed.length === 0) return null;
        return (
          <section key={tier} className="flex flex-col gap-[4px]">
            <h2 className="m-0 px-md font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
              {label}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
              {listed.map((template) => {
                const selected =
                  template.id === selectedId && template.tier === selectedTier;
                return (
                  <li key={`${template.tier}:${template.id}`}>
                    <button
                      type="button"
                      data-selected={selected}
                      aria-current={selected ? "page" : undefined}
                      disabled={disabled}
                      onClick={() => onSelect(template)}
                      className="group relative flex w-full cursor-pointer flex-col gap-[4px] rounded-md border border-solid border-transparent bg-transparent px-md py-[9px] text-left transition-colors duration-150 hover:border-border-subtle hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 disabled:cursor-not-allowed data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised"
                    >
                      <span
                        aria-hidden="true"
                        className="absolute top-[9px] bottom-[9px] left-0 w-[2px] rounded-full bg-transparent group-data-[selected=true]:bg-cyan"
                      />
                      <span className="font-mono text-[0.78rem] leading-[1.35] font-medium text-text-primary">
                        {template.name}
                      </span>
                      <span className="font-mono text-[0.7rem] text-text-tertiary">
                        {template.contexts}{" "}
                        {template.contexts === 1 ? "context" : "contexts"} ·{" "}
                        {formatLocalTime(template.updatedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

function NavItem({
  selected,
  onSelect,
  overline,
  title,
  trailing,
  changed,
}: {
  selected: boolean;
  onSelect(): void;
  overline: string;
  title: string;
  trailing?: React.ReactNode;
  changed: number;
}) {
  return (
    <li>
      <button
        type="button"
        data-selected={selected}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="group relative flex w-full cursor-pointer items-start gap-sm rounded-md border border-solid border-transparent bg-transparent px-md py-[8px] text-left transition-colors duration-150 hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised"
      >
        <span
          aria-hidden="true"
          className="absolute top-[8px] bottom-[8px] left-0 w-[2px] rounded-full bg-transparent group-data-[selected=true]:bg-cyan"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {overline}
          </span>
          <span className="truncate font-mono text-[0.76rem] font-medium text-text-primary">
            {title}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-[6px] pt-[2px]">
          {trailing}
          {changed > 0 ? (
            <span
              className="size-[6px] rounded-full bg-amber"
              title={`${changed} unsaved ${changed === 1 ? "change" : "changes"}`}
            >
              <span className="sr-only">{changed} unsaved</span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** The settings every context inherits, or one context's, each with the tier its value comes from. */
/** Why a global template's checks are offered from this project only. */
const GLOBAL_CHECKS_NOTE =
  "A global template runs in every project: these are this project's commands, and its checks are verified when the template is launched.";

function SettingsFields({
  settings,
  scope,
  inherited,
  globalTemplate,
  options,
  onSet,
  onReset,
}: {
  settings: CascadedSettings<RunSettings>;
  scope: "context" | "template";
  globalTemplate: boolean;
  /** For a context: where each setting comes from once its override is reset. */
  inherited: CascadedSettings<RunSettings> | null;
  options: TemplateEditorOptions;
  onSet<K extends RunSettingKey>(key: K, value: RunSettings[K]): void;
  onReset(key: RunSettingKey): void;
}) {
  const badge = (key: RunSettingKey) => (
    <TierBadge
      from={settings[key].from}
      scope={scope}
      resetLabel={
        inherited !== null && inherited[key].from === "template"
          ? "Use the template default"
          : "Use the Command Center default"
      }
      onReset={() => onReset(key)}
    />
  );
  const implementer = settings.implementer.value;
  return (
    <>
      <FieldSection
        title="Implementer"
        description="The agent that does the work."
        badge={badge("implementer")}
      >
        <SeatFields
          seat={seatOf(implementer)}
          options={options}
          onChange={(seat) =>
            onSet("implementer", { profile: implementer.profile, ...seat })
          }
        >
          <ProfileField
            value={implementer.profile}
            profiles={options.profiles}
            onChange={(profile) =>
              onSet("implementer", { ...implementer, profile })
            }
          />
        </SeatFields>
      </FieldSection>
      <FieldSection
        title="Reviewers"
        description="Blocking reviewers decide whether the work is accepted; advisory ones leave advice the implementer answers."
        badge={badge("reviewers")}
      >
        <ReviewersEditor
          reviewers={settings.reviewers.value}
          options={options}
          onChange={(reviewers) => onSet("reviewers", reviewers)}
        />
      </FieldSection>
      <FieldSection
        title="Checks"
        description={`Validation commands that run before reviewers read the work.${globalTemplate ? ` ${GLOBAL_CHECKS_NOTE}` : ""}`}
        badge={badge("checks")}
      >
        <ChecksEditor
          checks={settings.checks.value}
          available={options.checks}
          onChange={(checks) => onSet("checks", checks)}
        />
      </FieldSection>
      <FieldSection title="Policy">
        <SettingRow
          label="Human approval"
          hint="You approve the result before it is accepted."
          badge={badge("humanApproval")}
        >
          <Switch
            checked={settings.humanApproval.value}
            onCheckedChange={(checked) => onSet("humanApproval", checked)}
            aria-label="Human approval"
          />
        </SettingRow>
        <SettingRow
          label="Agent questions"
          hint="Agents may ask the owner conversation when they cannot proceed."
          badge={badge("ownerQuestions")}
        >
          <Switch
            checked={settings.ownerQuestions.value}
            onCheckedChange={(checked) => onSet("ownerQuestions", checked)}
            aria-label="Agent questions"
          />
        </SettingRow>
        <SettingRow
          label="Turn time limit"
          hint="Per agent invocation. Leave empty for no time limit."
          badge={badge("timeoutMs")}
        >
          <span className="flex items-center gap-sm">
            <NumberField
              label="Turn time limit in minutes"
              min={1}
              value={minutesOf(settings.timeoutMs.value)}
              nullable
              onChange={(minutes) => onSet("timeoutMs", timeoutMsOf(minutes))}
            />
            <span className="font-mono text-[0.72rem] text-text-tertiary">
              min
            </span>
          </span>
        </SettingRow>
      </FieldSection>
    </>
  );
}

const LABEL =
  "font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase";

function ContentFields({
  context,
  schemaText: text,
  onEdit,
  onSchemaText,
}: {
  context: RunTemplateContext;
  schemaText: string;
  onEdit(change: Parameters<typeof editContext>[2]): void;
  onSchemaText(text: string): void;
}) {
  const outcome = schemaTextOutcome(text);
  const problem = outcome.ok ? null : outcome.message;
  const empty = text.trim() === "";
  return (
    <FieldSection
      title="Work"
      description="What the context is asked to do. {{inputs.<name>}} inserts a parameter at launch, in the title, brief, tasks and criteria."
    >
      <label className="flex flex-col gap-[6px]">
        <span className={LABEL}>Title</span>
        <input
          className={INPUT}
          value={context.title ?? ""}
          placeholder={untitledName(context)}
          onChange={(event) => onEdit({ title: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[6px]">
        <span className={LABEL}>Brief</span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[96px]")}
          rows={4}
          value={context.brief}
          onValueChange={(brief) => onEdit({ brief })}
        />
      </label>
      <div className="flex flex-col gap-sm">
        <span className={LABEL}>Tasks</span>
        <ListEditor
          items={(context.tasks ?? []).map((task) => ({
            text: task.title,
            instructions: task.instructions ?? "",
          }))}
          instructions
          noun="Task"
          placeholder="What the agent marks done"
          onChange={(items) =>
            onEdit({
              tasks: items.map((item) => ({
                title: item.text,
                instructions: item.instructions,
              })),
            })
          }
        />
      </div>
      <div className="flex flex-col gap-sm">
        <span className={LABEL}>Acceptance criteria</span>
        <ListEditor
          items={(context.acceptanceCriteria ?? []).map((text) => ({
            text,
            instructions: "",
          }))}
          noun="Criterion"
          placeholder="What a reviewer checks"
          onChange={(items) =>
            onEdit({ acceptanceCriteria: items.map((item) => item.text) })
          }
        />
      </div>
      <label className="flex flex-col gap-[6px]">
        <span className="flex items-center gap-sm">
          <span className={LABEL}>Output schema</span>
          <span
            className={cn(
              "font-mono text-[0.7rem]",
              problem !== null
                ? "text-red-text"
                : empty
                  ? "text-text-tertiary"
                  : "text-green",
            )}
          >
            {problem !== null
              ? "Needs correction"
              : empty
                ? "optional"
                : "Schema validated"}
          </span>
        </span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[88px] text-[0.72rem]")}
          rows={empty ? 2 : 8}
          spellCheck={false}
          value={text}
          placeholder='{ "type": "object", "properties": { … } }'
          aria-invalid={problem !== null}
          onValueChange={onSchemaText}
        />
        <span
          className={cn(
            "font-mono text-[0.7rem] leading-[1.5]",
            problem !== null ? "text-red-text" : "text-text-tertiary",
          )}
        >
          {problem ??
            "Without a schema, the accepted output is the implementer's closing summary."}
        </span>
      </label>
    </FieldSection>
  );
}

function Placement({
  context,
  draft,
}: {
  context: RunTemplateContext;
  draft: RunTemplateContent;
}) {
  const dependencies = dependenciesOf(context);
  const loop = loopOf(draft, context.key);
  const scope = context.scope ?? { mode: "full" };
  const outputOnly = dependencies.filter((dependency) => dependency.outputOnly);
  return (
    <div className="flex flex-wrap items-center gap-x-lg gap-y-[6px] rounded-lg border border-dashed border-border-default px-lg py-md font-mono text-[0.72rem] text-text-secondary">
      <span>
        {dependencies.length === 0
          ? "Starts first"
          : `After ${dependencies.map((dependency) => dependency.key).join(", ")}`}
      </span>
      <span>
        {scope.mode === "readOnly"
          ? "Read-only"
          : scope.mode === "owned"
            ? `Writes ${scope.paths.join(", ")}`
            : "Full worktree access"}
      </span>
      {outputOnly.length > 0 ? (
        <span>
          Output only from{" "}
          {outputOnly.map((dependency) => dependency.key).join(", ")}
        </span>
      ) : null}
      {dependencies.flatMap((dependency) =>
        dependency.guard === null
          ? []
          : [
              <span key={dependency.key}>
                Route from {dependency.key}: {dependency.guard}
              </span>,
            ],
      )}
      <span className="inline-flex items-center gap-[6px]">
        <BranchIcon size={12} />
        {context.lane === undefined
          ? "session worktree"
          : `lane ${context.lane}`}
      </span>
      {loop !== null ? (
        <span className="inline-flex items-center gap-[6px]">
          <LoopIcon size={12} />
          loop {loop.key} · up to {loop.maxPasses} passes until {loop.until}
        </span>
      ) : null}
      <span className="basis-full text-text-tertiary">
        Contexts, dependencies, routes, loops and lanes change when an agent
        saves a new definition.
      </span>
    </div>
  );
}

function DetailsFields({
  draft,
  onChange,
}: {
  draft: RunTemplateContent;
  onChange(change: Partial<RunTemplateContent>): void;
}) {
  const parameters = draft.parameters;
  const replace = (
    index: number,
    change: Partial<RunTemplateContent["parameters"][number]>,
  ) =>
    onChange({
      parameters: parameters.map((other, at) =>
        at === index ? { ...other, ...change } : other,
      ),
    });
  return (
    <FieldSection title="Details">
      <label className="flex flex-col gap-[6px]">
        <span className={LABEL}>Name</span>
        <input
          className={INPUT}
          value={draft.name}
          maxLength={120}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[6px]">
        <span className={LABEL}>Description</span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[64px]")}
          rows={2}
          value={draft.description}
          onValueChange={(description) => onChange({ description })}
        />
      </label>
      <div className="flex flex-col gap-sm">
        <span className={LABEL}>Parameters</span>
        {parameters.length === 0 ? (
          <span className="font-mono text-[0.72rem] text-text-tertiary">
            None. A parameter is a value the person launching gives, which
            {" {{inputs.<name>}}"} inserts.
          </span>
        ) : null}
        {parameters.map((parameter, index) => (
          <div
            // Parameters are renamed in place; their position is their identity while editing.
            key={index}
            className="grid grid-cols-[130px_minmax(0,1fr)_auto_auto] items-center gap-sm rounded-md border border-solid border-border-dim bg-bg-base p-md max-768:grid-cols-[minmax(0,1fr)_auto]"
          >
            <input
              aria-label={`Parameter ${index + 1} name`}
              className={cn(FIELD, "w-full max-768:col-span-2")}
              value={parameter.name}
              onChange={(event) => replace(index, { name: event.target.value })}
            />
            <input
              aria-label={`Parameter ${index + 1} description`}
              className={cn(INPUT, "max-768:col-span-2")}
              value={parameter.description}
              placeholder="What the person launching gives"
              onChange={(event) =>
                replace(index, { description: event.target.value })
              }
            />
            <label className="flex shrink-0 items-center gap-sm font-mono text-[0.72rem] text-text-secondary">
              <Switch
                size="sm"
                checked={parameter.required}
                aria-label={`Parameter ${index + 1} required`}
                onCheckedChange={(required) => replace(index, { required })}
              />
              required
            </label>
            <WithTooltip label="Remove parameter">
              <IconButton
                variant="ghost"
                tone="danger"
                aria-label={`Remove parameter ${index + 1}`}
                onClick={() =>
                  onChange({
                    parameters: parameters.filter((_, at) => at !== index),
                  })
                }
              >
                <CloseIcon />
              </IconButton>
            </WithTooltip>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          layoutClassName="-ml-[12px] self-start"
          onClick={() =>
            onChange({
              parameters: [
                ...parameters,
                { name: "", description: "", required: false },
              ],
            })
          }
        >
          <PlusIcon size={12} />
          Add parameter
        </Button>
      </div>
    </FieldSection>
  );
}

function SaveBar({
  count,
  state,
  revision,
  onDiscard,
  onSave,
  onReload,
  invalid,
  pending,
}: {
  pending: boolean;
  count: number;
  invalid: boolean;
  state: "idle" | "conflict";
  revision: number;
  onDiscard(): void;
  onSave(): void;
  onReload(): void;
}) {
  const [confirmReload, setConfirmReload] = useState(false);
  if (count === 0 && state === "idle") return null;
  const conflict = state === "conflict";
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        "flex flex-wrap items-center gap-md border-x-0 border-t border-b-0 border-solid px-2xl py-md max-768:px-lg",
        conflict
          ? "border-[var(--cc-red-a40)] bg-[var(--cc-red-a08)]"
          : "border-border-default bg-bg-surface",
      )}
    >
      <span
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          conflict ? "bg-red" : "bg-amber",
        )}
      />
      <span className="font-mono text-[0.78rem] font-medium text-text-primary">
        {conflict
          ? "A newer revision was saved while you edited"
          : `${count} unsaved ${count === 1 ? "change" : "changes"}`}
      </span>
      <span className="min-w-0 truncate font-mono text-[0.72rem] text-text-tertiary max-900:hidden">
        {conflict
          ? "Reloading replaces this draft and discards its unsaved changes."
          : "Runs already launched keep the revision they started from."}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-sm">
        <Button
          size="sm"
          variant={conflict ? "default" : "ghost"}
          loading={pending && conflict}
          disabled={pending}
          onClick={
            conflict
              ? () => (count > 0 ? setConfirmReload(true) : onReload())
              : onDiscard
          }
        >
          {conflict ? "Reload latest" : "Discard"}
        </Button>
        <Button
          size="sm"
          variant={conflict ? "default" : "primary"}
          loading={pending && !conflict}
          disabled={pending || invalid || conflict}
          onClick={onSave}
        >
          {pending && !conflict
            ? "Saving…"
            : `Save as revision ${revision + 1}`}
        </Button>
      </span>
      {conflict && confirmReload ? (
        <div
          role="group"
          aria-label="Confirm template reload"
          className="flex basis-full flex-wrap items-center gap-md rounded-md border border-solid border-border-default bg-bg-base p-md max-768:flex-col max-768:items-stretch"
        >
          <p className="m-0 min-w-0 flex-1 font-mono text-[0.72rem] leading-[1.5] text-text-secondary">
            Reloading discards your {count} unsaved{" "}
            {count === 1 ? "change" : "changes"} and replaces this draft with
            the latest saved revision.
          </p>
          <div className="flex flex-wrap items-center gap-sm">
            <Button
              size="sm"
              variant="ghost"
              autoFocus
              onClick={() => setConfirmReload(false)}
            >
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                setConfirmReload(false);
                onReload();
              }}
            >
              Discard and reload
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * A saved template, edited as forms: its details and the defaults its
 * contexts inherit, then each context's work and settings, every setting
 * showing the tier it comes from. Structure stays read-only.
 */
function TemplateEditorBody({
  templates,
  template,
  tier,
  globals,
  options,
  actions,
  initialSelection = TEMPLATE_PART,
  initialView = "edit",
  initialDraft,
  initialSaveState = "idle",
}: {
  templates: readonly RunTemplateSummary[];
  /** The stored template; a newer revision is adopted while the draft has no changes. */
  template: RunTemplateRecord;
  tier: RunTemplateTier;
  /** The Command Center defaults: what a setting no tier sets falls back to. */
  globals: RunSettings;
  options: TemplateEditorOptions;
  actions: TemplateEditorActions;
  /** A context key, or the template part. */
  initialSelection?: string;
  initialView?: View;
  /** Stories open the editor mid-edit. */
  initialDraft?: RunTemplateContent;
  initialSaveState?: "idle" | "conflict";
}) {
  const [saved, setSaved] = useState(template);
  const [draft, setDraft] = useState<RunTemplateContent>(
    initialDraft ?? contentOf(template),
  );
  // Output schema text being typed, by context key, until it is a schema the draft can hold.
  const [schemaTexts, setSchemaTexts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [saveState, setSaveState] = useState(initialSaveState);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selection, setSelection] = useState(initialSelection);
  const [view, setView] = useState<View>(initialView);

  const counts = useMemo(
    () => changeCounts(contentOf(saved), draft),
    [saved, draft],
  );
  const schemaProblems: DraftProblem[] = Object.entries(schemaTexts).flatMap(
    ([key, text]) => {
      const outcome = schemaTextOutcome(text);
      return outcome.ok
        ? []
        : [
            {
              part: key,
              location: `${key} · outputSchema`,
              message: outcome.message,
            },
          ];
    },
  );
  const validation = useMemo(() => draftProblems(draft), [draft]);
  const problems = [...schemaProblems, ...validation];
  const changedParts = new Map(counts);
  for (const problem of schemaProblems)
    changedParts.set(problem.part, (changedParts.get(problem.part) ?? 0) + 1);
  const total = [...changedParts.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const invalid = problems.length > 0;

  // Whenever the editor is clean, idle and behind the newest stored revision
  // it knows of, it moves to that revision; a dirty, saving or conflicted
  // editor keeps its draft and base revision until that changes. Only a
  // strictly newer revision is taken, so a stale refresh never steps back.
  if (
    template.revision > saved.revision &&
    total === 0 &&
    !pending &&
    saveState === "idle"
  ) {
    setSaved(template);
    setDraft(contentOf(template));
    setSchemaTexts({});
  }

  const selected =
    draft.workflow.contexts.find((context) => context.key === selection) ??
    null;
  const shownTemplate = templateSettings(globals, draft);

  const save = async () => {
    if (pending || invalid || saveState !== "idle") return;
    const submitted = draft;
    setPending(true);
    setActionError(null);
    try {
      const result = await actions.onSave(submitted, saved.revision);
      if (result.kind === "conflict") {
        setSaveState("conflict");
        return;
      }
      setSaved(result.template);
      setDraft((current) =>
        deepEqualJson(current, submitted)
          ? contentOf(result.template)
          : current,
      );
    } catch (error) {
      setActionError(errorText(error, "Could not save the template."));
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      const latest = await actions.onReload();
      setSaved(latest);
      setDraft(contentOf(latest));
      setSchemaTexts({});
      setSaveState("idle");
    } catch (error) {
      setActionError(errorText(error, "Could not reload the template."));
    } finally {
      setPending(false);
    }
  };

  const diagram = useMemo(
    () => templateDiagram(globals, draft, options.models),
    [globals, draft, options.models],
  );
  const lanes = draft.workflow.lanes ?? [];
  const loops = draft.workflow.loops ?? [];

  return (
    <div className="flex h-full min-h-0 w-full bg-bg-void">
      <aside className="w-[248px] shrink-0 overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-dim bg-bg-base px-sm py-xl max-1080:hidden">
        <TemplatesRail
          templates={templates}
          selectedId={saved.id}
          selectedTier={tier}
          disabled={total > 0 || pending}
          onSelect={actions.onSelectTemplate}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-xl overflow-y-auto px-2xl py-xl max-768:px-lg">
          {templates.length > 1 ? (
            <div className="hidden max-1080:block">
              <Select
                value={`${tier}:${saved.id}`}
                onValueChange={(value) => {
                  const next = templates.find(
                    (item) => `${item.tier}:${item.id}` === value,
                  );
                  if (next !== undefined) actions.onSelectTemplate(next);
                }}
                disabled={total > 0 || pending}
              >
                <SelectTrigger aria-label="Template" layoutClassName="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((item) => (
                    <SelectItem
                      key={`${item.tier}:${item.id}`}
                      value={`${item.tier}:${item.id}`}
                    >
                      {item.name} · {item.tier}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <header className="flex flex-wrap items-start gap-lg">
            <div className="flex min-w-0 flex-1 flex-col gap-sm max-768:basis-full">
              <span className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
                {tier === "project" ? "Project template" : "Global template"} ·
                revision {saved.revision} · saved{" "}
                {formatLocalTime(saved.updatedAt)}
              </span>
              <h1 className="m-0 font-display text-[1.75rem] leading-[1.1] font-extrabold break-words text-text-primary max-768:text-[1.35rem]">
                {draft.name.trim() === "" ? saved.name : draft.name}
              </h1>
              {draft.description !== "" ? (
                <p className="m-0 max-w-[720px] font-mono text-[0.75rem] leading-[1.55] text-text-secondary">
                  {draft.description}
                </p>
              ) : null}
              <span className="flex flex-wrap items-center gap-x-lg gap-y-[4px] font-mono text-[0.72rem] text-text-tertiary">
                <span>
                  {draft.workflow.contexts.length}{" "}
                  {draft.workflow.contexts.length === 1
                    ? "context"
                    : "contexts"}
                </span>
                <span>
                  {lanes.length} {lanes.length === 1 ? "lane" : "lanes"}
                </span>
                <span>
                  {loops.length} {loops.length === 1 ? "loop" : "loops"}
                </span>
                <span>
                  parameters:{" "}
                  {draft.parameters
                    .map(
                      (parameter) =>
                        `${parameter.name || "unnamed"}${parameter.required ? "" : "?"}`,
                    )
                    .join(", ") || "none"}
                </span>
              </span>
            </div>
            <div className="flex max-w-full min-w-0 shrink-0 flex-col items-end gap-sm max-768:items-start">
              <div className="flex items-center gap-sm">
                <SegmentedControl
                  value={view}
                  aria-label="Show the template as"
                  onValueChange={(value) =>
                    setView(value === "diagram" ? "diagram" : "edit")
                  }
                >
                  <SegmentedControlItem value="edit">
                    <ListIcon size={13} />
                    Edit
                  </SegmentedControlItem>
                  <SegmentedControlItem value="diagram">
                    <DiagramIcon size={13} />
                    Structure
                  </SegmentedControlItem>
                </SegmentedControl>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={total > 0 || pending || saveState !== "idle"}
                  onClick={() => actions.onLaunch(saved)}
                >
                  <PlayIcon size={12} />
                  Launch
                </Button>
              </div>
              {total > 0 ? (
                <span className="max-w-[300px] font-mono text-[0.7rem] text-amber">
                  Save or discard edits before launching or switching templates.
                </span>
              ) : null}
            </div>
          </header>

          {view === "diagram" ? (
            <div className="flex flex-col gap-sm">
              <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
                Read-only. Select a context to edit it.
              </p>
              <div className="h-[520px]">
                <RunDiagram
                  template
                  contexts={diagram.contexts}
                  edges={diagram.edges}
                  lanes={diagram.lanes}
                  loops={diagram.loops}
                  selectedKey={selected?.key ?? null}
                  onSelect={(key) => {
                    setSelection(key);
                    setView("edit");
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-xl max-900:flex-col">
              {/* On a narrow screen the parts list becomes a picker above the form. */}
              <div className="hidden w-full max-900:block">
                <Select value={selection} onValueChange={setSelection}>
                  <SelectTrigger
                    aria-label="Part to edit"
                    layoutClassName="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TEMPLATE_PART}>
                      Details and defaults
                    </SelectItem>
                    {draft.workflow.contexts.map((context) => (
                      <SelectItem key={context.key} value={context.key}>
                        {context.key} · {contextTitle(context)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <nav
                aria-label="Template parts"
                className="sticky top-0 flex w-[236px] shrink-0 flex-col gap-lg max-900:hidden"
              >
                <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                  <NavItem
                    selected={selection === TEMPLATE_PART}
                    onSelect={() => setSelection(TEMPLATE_PART)}
                    overline="template"
                    title="Details and defaults"
                    changed={changedParts.get(TEMPLATE_PART) ?? 0}
                    trailing={
                      <span className="text-text-tertiary">
                        <DocumentIcon size={12} />
                      </span>
                    }
                  />
                </ul>
                <section className="flex flex-col gap-[4px]">
                  <h2 className="m-0 px-md font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
                    Contexts{" "}
                    <span className="font-normal">
                      {draft.workflow.contexts.length}
                    </span>
                  </h2>
                  <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                    {draft.workflow.contexts.map((context) => {
                      const set = Object.keys(context.settings ?? {}).length;
                      const loop = loopOf(draft, context.key);
                      return (
                        <NavItem
                          key={context.key}
                          selected={selection === context.key}
                          onSelect={() => setSelection(context.key)}
                          overline={context.key}
                          title={contextTitle(context)}
                          changed={changedParts.get(context.key) ?? 0}
                          trailing={
                            <>
                              {context.lane !== undefined ? (
                                <span
                                  className="text-text-tertiary"
                                  title={`lane ${context.lane}`}
                                >
                                  <BranchIcon size={11} />
                                </span>
                              ) : null}
                              {loop !== null ? (
                                <span
                                  className="text-text-tertiary"
                                  title={`loop ${loop.key}`}
                                >
                                  <LoopIcon size={11} />
                                </span>
                              ) : null}
                              {set > 0 ? (
                                <span
                                  className="font-mono text-[0.7rem] text-cyan"
                                  title={`${set} ${set === 1 ? "setting" : "settings"} set here`}
                                >
                                  {set}
                                </span>
                              ) : null}
                            </>
                          }
                        />
                      );
                    })}
                  </ul>
                </section>
              </nav>

              <div className="flex max-w-[760px] min-w-0 flex-1 flex-col gap-lg max-900:w-full max-900:max-w-none">
                {selected === null ? (
                  <>
                    <DetailsFields
                      draft={draft}
                      onChange={(change) =>
                        setDraft((current) => ({ ...current, ...change }))
                      }
                    />
                    <div className="flex flex-col gap-[4px] pt-sm">
                      <h2 className="m-0 font-mono text-[0.82rem] font-semibold text-text-primary">
                        Defaults
                      </h2>
                      <p className="m-0 max-w-[680px] font-mono text-[0.72rem] leading-[1.55] text-text-tertiary">
                        Every context uses these unless it sets its own. A
                        setting this template leaves unset takes the Command
                        Center default; Settings → Workflow does not change run
                        templates yet.
                      </p>
                    </div>
                    <SettingsFields
                      settings={shownTemplate}
                      scope="template"
                      inherited={null}
                      globalTemplate={tier === "global"}
                      options={options}
                      onSet={(key, value) =>
                        setDraft((current) => setDefault(current, key, value))
                      }
                      onReset={(key) =>
                        setDraft((current) => resetDefault(current, key))
                      }
                    />
                    {lanes.length > 0 ? (
                      <FieldSection
                        title="Lane checks"
                        description={`Run on each lane's merged tree before it publishes into the session branch.${tier === "global" ? ` ${GLOBAL_CHECKS_NOTE}` : ""}`}
                      >
                        {lanes.map((lane) => (
                          <SettingRow key={lane.key} label={`Lane ${lane.key}`}>
                            <ChecksEditor
                              checks={lane.checks ?? []}
                              available={options.checks}
                              label={`Add a check to lane ${lane.key}`}
                              onChange={(checks) =>
                                setDraft((current) =>
                                  setLaneChecks(current, lane.key, checks),
                                )
                              }
                            />
                          </SettingRow>
                        ))}
                      </FieldSection>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-xs">
                      <span className="font-mono text-[0.7rem] text-cyan">
                        CONTEXT / {selected.key}
                      </span>
                      <h2 className="m-0 font-display text-[1.15rem] font-bold break-words text-text-primary">
                        {contextTitle(selected)}
                      </h2>
                    </div>
                    <Placement context={selected} draft={draft} />
                    <ContentFields
                      context={selected}
                      schemaText={
                        schemaTexts[selected.key] ?? schemaText(selected)
                      }
                      onEdit={(change) =>
                        setDraft((current) =>
                          editContext(current, selected.key, change),
                        )
                      }
                      onSchemaText={(text) => {
                        setSchemaTexts((current) => ({
                          ...current,
                          [selected.key]: text,
                        }));
                        const outcome = schemaTextOutcome(text);
                        if (outcome.ok)
                          setDraft((current) =>
                            editContext(current, selected.key, {
                              outputSchema: outcome.schema,
                            }),
                          );
                      }}
                    />
                    <SettingsFields
                      settings={contextSettings(globals, draft, selected.key)}
                      scope="context"
                      inherited={shownTemplate}
                      globalTemplate={tier === "global"}
                      options={options}
                      onSet={(key, value) =>
                        setDraft((current) =>
                          setContextSetting(current, selected.key, key, value),
                        )
                      }
                      onReset={(key) =>
                        setDraft((current) =>
                          resetContextSetting(current, selected.key, key),
                        )
                      }
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {invalid ? (
          <div
            role="alert"
            className="flex max-h-[30vh] flex-wrap items-center gap-sm overflow-y-auto border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface px-2xl py-sm max-768:px-lg"
          >
            <span className="font-mono text-[0.72rem] text-red-text">
              Fix before saving:
            </span>
            {problems.map((problem, index) => (
              <button
                key={index}
                type="button"
                onClick={() => {
                  setSelection(problem.part);
                  setView("edit");
                }}
                className="cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-[0.72rem] text-red-text underline underline-offset-2 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {problem.location}: {problem.message}
              </button>
            ))}
          </div>
        ) : null}
        {actionError !== null ? (
          <p
            role="alert"
            className="m-0 px-2xl py-sm font-mono text-[0.72rem] whitespace-pre-line text-red-text"
          >
            {actionError}
          </p>
        ) : null}
        <SaveBar
          pending={pending}
          count={total}
          invalid={invalid}
          state={saveState}
          revision={saved.revision}
          onDiscard={() => {
            // Discarding returns to the newest stored revision the editor knows of.
            const latest =
              template.revision > saved.revision ? template : saved;
            setSaved(latest);
            setDraft(contentOf(latest));
            setSchemaTexts({});
          }}
          onReload={() => {
            void reload();
          }}
          onSave={() => {
            void save();
          }}
        />
      </div>
    </div>
  );
}

/** A template switch begins a separate draft; a new saved revision keeps current edits. */
export function TemplateEditor(
  props: Parameters<typeof TemplateEditorBody>[0],
) {
  return (
    <TemplateEditorBody key={`${props.tier}:${props.template.id}`} {...props} />
  );
}
