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
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";
import { cn } from "@/lib/ui/cn";
import { DiagramIcon, ListIcon, LoopIcon, PlayIcon } from "../../icons";
import type { RunContext, RunEdge } from "../../model";
import type {
  CatalogOption,
  ConfigBlock,
  ConfigKey,
  Template,
  TemplateContext,
  TemplateSummary,
  Tier,
} from "../../template-model";
import { RunDiagram } from "../RunDiagram";
import {
  ChecksEditor,
  FIELD,
  FieldSection,
  INPUT,
  ListEditor,
  NumberField,
  ReviewersEditor,
  SeatFields,
  SettingRow,
  TEXTAREA,
  TierBadge,
} from "./fields";

export interface TemplateEditorOptions {
  catalog: CatalogOption[];
  efforts: string[];
  profiles: string[];
  checks: string[];
}

export interface TemplateEditorActions {
  onSelectTemplate(template: TemplateSummary): void;
  /** Fetch the current template; the editor applies it after explicit discard confirmation. */
  onReload(): Template | Promise<Template>;
  /** The draft carries its base revision. Return the persisted snapshot to acknowledge saving. */
  onSave(draft: Template): Template | void | Promise<Template | void>;
  onLaunch(): void;
}

type Selection = "defaults" | string;
type View = "edit" | "diagram";

/** One setting replaced; `{ value, from }` is exactly `ConfigBlock[K]` for every key. */
function withSetting<K extends ConfigKey>(
  block: ConfigBlock,
  key: K,
  value: ConfigBlock[K]["value"],
  from: Tier,
): ConfigBlock {
  const next = { ...block };
  next[key] = { value, from } as ConfigBlock[K];
  return next;
}

const CONFIG_KEYS: ConfigKey[] = [
  "implementer",
  "reviewers",
  "checks",
  "humanApproval",
  "ownerQuestions",
  "unfinishedTaskRetries",
  "validationRetries",
  "captureRepairLimit",
  "instabilityLimit",
  "adviceCorrectionLimit",
  "timeoutMinutes",
];

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** How many fields differ from the saved revision, by context or the defaults. */
function changes(saved: Template, draft: Template): Map<Selection, number> {
  const counts = new Map<Selection, number>();
  const bump = (selection: Selection) =>
    counts.set(selection, (counts.get(selection) ?? 0) + 1);
  for (const key of CONFIG_KEYS)
    if (!same(saved.defaults[key], draft.defaults[key])) bump("defaults");
  for (const field of ["name", "description", "parameters", "lanes"] as const)
    if (!same(saved[field], draft[field])) bump("defaults");
  for (const context of draft.contexts) {
    const before = saved.contexts.find((other) => other.key === context.key);
    if (before === undefined) continue;
    for (const field of [
      "title",
      "brief",
      "tasks",
      "criteria",
      "outputSchema",
    ] as const)
      if (!same(before[field], context[field])) bump(context.key);
    for (const key of CONFIG_KEYS)
      if (
        !same(before.config[key], context.config[key]) &&
        (before.config[key].from === "context" ||
          context.config[key].from === "context")
      )
        bump(context.key);
  }
  return counts;
}

function schemaProblem(text: string): string | null {
  if (text.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const issue = validateOutputSchemaDeclaration(parsed)[0];
    return issue === undefined ? null : `${issue.path}: ${issue.message}`;
  } catch (error) {
    return error instanceof Error ? error.message : "Not valid JSON";
  }
}

function TemplatesRail({
  templates,
  selectedId,
  selectedTier,
  disabled,
  onSelect,
}: {
  templates: TemplateSummary[];
  selectedId: string;
  selectedTier: Template["tier"];
  disabled: boolean;
  onSelect(template: TemplateSummary): void;
}) {
  const tiers: Array<{ tier: TemplateSummary["tier"]; label: string }> = [
    { tier: "project", label: "This project" },
    { tier: "global", label: "Every project" },
  ];
  return (
    <nav aria-label="Templates" className="flex flex-col gap-xl">
      <span className="px-md font-display text-[1.05rem] font-bold text-text-primary">
        Templates
      </span>
      {tiers.map(({ tier, label }) => (
        <section key={tier} className="flex flex-col gap-[4px]">
          <h2 className="m-0 px-md font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
            {label}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
            {templates
              .filter((template) => template.tier === tier)
              .map((template) => (
                <li key={`${template.tier}:${template.id}`}>
                  <button
                    type="button"
                    data-selected={
                      template.id === selectedId &&
                      template.tier === selectedTier
                    }
                    aria-current={
                      template.id === selectedId &&
                      template.tier === selectedTier
                        ? "page"
                        : undefined
                    }
                    disabled={disabled}
                    onClick={() => onSelect(template)}
                    className="group relative flex w-full cursor-pointer flex-col gap-[4px] rounded-md border border-solid border-transparent bg-transparent px-md py-[9px] text-left transition-colors duration-150 hover:border-border-subtle hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[selected=true]:border-border-default data-[selected=true]:bg-bg-raised"
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
              ))}
          </ul>
        </section>
      ))}
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

function overrides(context: TemplateContext): number {
  return CONFIG_KEYS.filter((key) => context.config[key].from === "context")
    .length;
}

/** The settings every context inherits, or one context's, with the tier each value comes from. */
function ConfigFields({
  block,
  scope,
  options,
  onSet,
  onReset,
}: {
  block: ConfigBlock;
  scope: "context" | "template";
  options: TemplateEditorOptions;
  onSet<K extends ConfigKey>(key: K, value: ConfigBlock[K]["value"]): void;
  onReset(key: ConfigKey): void;
}) {
  const badge = (key: ConfigKey) => (
    <TierBadge
      from={block[key].from}
      scope={scope}
      onReset={() => onReset(key)}
    />
  );
  return (
    <>
      <FieldSection
        title="Implementer"
        description="The agent that does the work."
        badge={badge("implementer")}
      >
        <SeatFields
          seat={block.implementer.value}
          catalog={options.catalog}
          efforts={options.efforts}
          profiles={options.profiles}
          onChange={(seat) =>
            onSet("implementer", { ...block.implementer.value, ...seat })
          }
        />
      </FieldSection>
      <FieldSection
        title="Reviewers"
        description="Blocking reviewers decide whether the work is accepted; advisory ones leave advice the implementer answers."
        badge={badge("reviewers")}
      >
        <ReviewersEditor
          reviewers={block.reviewers.value}
          catalog={options.catalog}
          efforts={options.efforts}
          profiles={options.profiles}
          onChange={(reviewers) => onSet("reviewers", reviewers)}
        />
      </FieldSection>
      <FieldSection
        title="Checks"
        description="Validation commands that run before reviewers read the work."
        badge={badge("checks")}
      >
        <ChecksEditor
          checks={block.checks.value}
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
            checked={block.humanApproval.value}
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
            checked={block.ownerQuestions.value}
            onCheckedChange={(checked) => onSet("ownerQuestions", checked)}
            aria-label="Agent questions"
          />
        </SettingRow>
      </FieldSection>
      <FieldSection
        title="Limits"
        description="Each allowance is independent. Exhausting one halts the context for a decision."
      >
        <SettingRow
          label="Task retries"
          hint="Extra work turns after the first turn to finish open tasks."
          badge={badge("unfinishedTaskRetries")}
        >
          <NumberField
            label="Task retries"
            min={0}
            value={block.unfinishedTaskRetries.value}
            onChange={(value) => onSet("unfinishedTaskRetries", value)}
          />
        </SettingRow>
        <SettingRow
          label="Review retries"
          hint="Rounds of fixes after a failed review before the context halts."
          badge={badge("validationRetries")}
        >
          <NumberField
            label="Review retries"
            min={0}
            value={block.validationRetries.value}
            onChange={(value) => onSet("validationRetries", value)}
          />
        </SettingRow>
        {(
          [
            {
              key: "captureRepairLimit",
              label: "Output repairs",
              hint: "Retries when an agent's output does not match its schema.",
              min: 0,
            },
            {
              key: "instabilityLimit",
              label: "Candidate changes",
              hint: "Changed candidates before the context halts for a decision.",
              min: 1,
            },
            {
              key: "adviceCorrectionLimit",
              label: "Advice corrections",
              hint: "Retries to obtain a valid response to advisory findings.",
              min: 0,
            },
          ] as const
        ).map(({ key, label, hint, min }) => (
          <SettingRow key={key} label={label} hint={hint} badge={badge(key)}>
            <NumberField
              label={label}
              min={min}
              value={block[key].value}
              onChange={(value) => onSet(key, value)}
            />
          </SettingRow>
        ))}
        <SettingRow
          label="Turn time limit"
          hint="Per agent invocation. Leave empty for no time limit."
          badge={badge("timeoutMinutes")}
        >
          <span className="flex items-center gap-sm">
            <NumberField
              label="Turn time limit in minutes"
              min={1}
              value={block.timeoutMinutes.value}
              nullable
              onChange={(value) => onSet("timeoutMinutes", value)}
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

function ContentFields({
  context,
  onChange,
}: {
  context: TemplateContext;
  onChange(change: Partial<TemplateContext>): void;
}) {
  const problem = schemaProblem(context.outputSchema);
  return (
    <FieldSection
      title="Work"
      description="What the context is asked to do. {{name}} inserts a parameter at launch."
    >
      <label className="flex flex-col gap-[6px]">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Title
        </span>
        <input
          className={INPUT}
          value={context.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[6px]">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Brief
        </span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[96px]")}
          rows={4}
          value={context.brief}
          onValueChange={(brief) => onChange({ brief })}
        />
      </label>
      <div className="flex flex-col gap-sm">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Tasks
        </span>
        <ListEditor
          items={context.tasks.map((task) => ({
            id: task.id,
            text: task.title,
            instructions: task.instructions,
          }))}
          instructions
          idPrefix="t"
          addLabel="Add task"
          placeholder="What the agent marks done"
          onChange={(items) =>
            onChange({
              tasks: items.map((item) => ({
                id: item.id,
                title: item.text,
                instructions: item.instructions ?? "",
              })),
            })
          }
        />
      </div>
      <div className="flex flex-col gap-sm">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Acceptance criteria
        </span>
        <ListEditor
          items={context.criteria}
          idPrefix="ac-"
          addLabel="Add criterion"
          placeholder="What a reviewer checks"
          onChange={(criteria) => onChange({ criteria })}
        />
      </div>
      <label className="flex flex-col gap-[6px]">
        <span className="flex items-center gap-sm">
          <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
            Output schema
          </span>
          <span
            className={cn(
              "font-mono text-[0.7rem]",
              problem !== null
                ? "text-red-text"
                : context.outputSchema.trim() === ""
                  ? "text-text-tertiary"
                  : "text-green",
            )}
          >
            {problem !== null
              ? "Needs correction"
              : context.outputSchema.trim() === ""
                ? "optional"
                : "Schema validated"}
          </span>
        </span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[88px] text-[0.72rem]")}
          rows={context.outputSchema.trim() === "" ? 2 : 8}
          spellCheck={false}
          value={context.outputSchema}
          placeholder='{ "type": "object", "properties": { … } }'
          aria-invalid={problem !== null}
          onValueChange={(outputSchema) => onChange({ outputSchema })}
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
  template,
}: {
  context: TemplateContext;
  template: Template;
}) {
  const loop = template.loops.find(
    (candidate) => candidate.key === context.loop,
  );
  return (
    <div className="flex flex-wrap items-center gap-x-lg gap-y-[6px] rounded-lg border border-dashed border-border-default px-lg py-md font-mono text-[0.72rem] text-text-secondary">
      <span>
        {context.dependsOn.length === 0
          ? "Starts first"
          : `After ${context.dependsOn.join(", ")}`}
      </span>
      <span>
        {context.scope.mode === "readOnly"
          ? "Read-only"
          : context.scope.mode === "owned"
            ? `Writes ${context.scope.paths.join(", ")}`
            : "Full worktree access"}
      </span>
      {context.outputOnly.length > 0 ? (
        <span>Output only from {context.outputOnly.join(", ")}</span>
      ) : null}
      {Object.entries(context.guards).map(([source, guard]) => (
        <span key={source}>
          Route from {source}: {guard}
        </span>
      ))}
      <span className="inline-flex items-center gap-[6px]">
        <BranchIcon size={12} />
        {context.lane === null ? "session worktree" : `lane ${context.lane}`}
      </span>
      {loop !== undefined ? (
        <span className="inline-flex items-center gap-[6px]">
          <LoopIcon size={12} />
          loop {loop.key} · up to {loop.maxPasses} passes until {loop.until}
        </span>
      ) : null}
      <span className="basis-full text-text-tertiary">
        Contexts, dependencies, routes, loops and lanes change when an agent
        edits the definition.
      </span>
    </div>
  );
}

function DetailsFields({
  draft,
  onChange,
}: {
  draft: Template;
  onChange(change: Partial<Template>): void;
}) {
  return (
    <FieldSection title="Details">
      <label className="flex flex-col gap-[6px]">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Name
        </span>
        <input
          className={INPUT}
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[6px]">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Description
        </span>
        <MultilineInput
          className={cn(TEXTAREA, "min-h-[64px]")}
          rows={2}
          value={draft.description}
          onValueChange={(description) => onChange({ description })}
        />
      </label>
      <div className="flex flex-col gap-sm">
        <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
          Parameters
        </span>
        {draft.parameters.map((parameter, index) => (
          <div
            key={index}
            className="grid grid-cols-[130px_minmax(0,1fr)_auto_auto] items-center gap-sm rounded-md border border-solid border-border-dim bg-bg-base p-md max-768:grid-cols-[minmax(0,1fr)_auto]"
          >
            <input
              aria-label={`Parameter ${index + 1} name`}
              className={cn(FIELD, "w-full max-768:col-span-2")}
              value={parameter.name}
              onChange={(event) =>
                onChange({
                  parameters: draft.parameters.map((other, at) =>
                    at === index
                      ? { ...other, name: event.target.value }
                      : other,
                  ),
                })
              }
            />
            <input
              aria-label={`Parameter ${index + 1} description`}
              className={cn(INPUT, "max-768:col-span-2")}
              value={parameter.description}
              onChange={(event) =>
                onChange({
                  parameters: draft.parameters.map((other, at) =>
                    at === index
                      ? { ...other, description: event.target.value }
                      : other,
                  ),
                })
              }
            />
            <label className="flex shrink-0 items-center gap-sm font-mono text-[0.72rem] text-text-secondary">
              <Switch
                size="sm"
                checked={parameter.required}
                aria-label={`Parameter ${index + 1} required`}
                onCheckedChange={(required) =>
                  onChange({
                    parameters: draft.parameters.map((other, at) =>
                      at === index ? { ...other, required } : other,
                    ),
                  })
                }
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
                    parameters: draft.parameters.filter(
                      (_, at) => at !== index,
                    ),
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
                ...draft.parameters,
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
  state: "idle" | "saving" | "conflict";
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
          disabled={pending || state === "saving"}
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
          loading={state === "saving" || (pending && !conflict)}
          disabled={pending || invalid || conflict}
          onClick={onSave}
        >
          {`Save as revision ${revision + 1}`}
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

function asRunContext(context: TemplateContext): RunContext {
  const implementer = context.config.implementer.value;
  return {
    key: context.key,
    title: context.title,
    placement:
      context.lane === null
        ? { kind: "session" }
        : { kind: "lane", lane: context.lane },
    loop:
      context.loop !== null
        ? { key: context.loop, pass: 1, maxPasses: 1 }
        : null,
    dependsOn: context.dependsOn,
    state: {
      kind: "waiting",
      dependencies: context.dependsOn,
      provisionLanes: [],
      publicationLanes: [],
    },
    tasks: { done: 0, total: context.tasks.length },
    questions: [],
    costUsd: null,
    costComplete: true,
    implementer: {
      assignment: "implementer",
      role: "implementer",
      backend: implementer.backend,
      model: implementer.model,
      effort: implementer.effort,
    },
    reviewers: context.config.reviewers.value.map((reviewer, index) => ({
      assignment: `reviewer-${index + 1}`,
      role: "reviewer",
      backend: reviewer.backend,
      model: reviewer.model,
      effort: reviewer.effort,
      authority: reviewer.authority,
      focus: reviewer.focus,
    })),
    humanApproval: context.config.humanApproval.value,
    startedAt: null,
  };
}

/**
 * A saved template, edited as forms: its details and the defaults its
 * contexts inherit, then each context's work and settings, every setting
 * showing the tier it comes from. Structure stays read-only.
 */
function TemplateEditorBody({
  templates,
  template,
  options,
  actions,
  initialSelection = "defaults",
  initialView = "edit",
  initialDraft,
  saveState = "idle",
}: {
  templates: TemplateSummary[];
  template: Template;
  options: TemplateEditorOptions;
  actions: TemplateEditorActions;
  initialSelection?: Selection;
  initialView?: View;
  /** Stories open the editor mid-edit. */
  initialDraft?: Template;
  saveState?: "idle" | "saving" | "conflict";
}) {
  const [saved, setSaved] = useState(template);
  const [draft, setDraft] = useState<Template>(initialDraft ?? template);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [view, setView] = useState<View>(initialView);
  const counts = useMemo(() => changes(saved, draft), [saved, draft]);
  const declaredParameters = new Set(
    draft.parameters.map((parameter) => parameter.name),
  );
  const problems = [
    ...(draft.name.trim() === ""
      ? [{ selection: "defaults", message: "Give the template a name." }]
      : []),
    ...draft.parameters.flatMap((parameter, index) =>
      parameter.name.trim() === ""
        ? [
            {
              selection: "defaults",
              message: `Parameter ${index + 1} needs a name.`,
            },
          ]
        : draft.parameters.some(
              (other, at) => at !== index && other.name === parameter.name,
            )
          ? [
              {
                selection: "defaults",
                message: `Parameter ${parameter.name} appears more than once.`,
              },
            ]
          : [],
    ),
    ...draft.contexts.flatMap((context) => {
      const errors = [
        ...(context.title.trim() === "" ? ["Add a title."] : []),
        ...(context.brief.trim() === "" ? ["Add a brief."] : []),
        ...context.tasks
          .filter((task) => task.title.trim() === "")
          .map((task) => `Task ${task.id} needs a title.`),
        ...context.criteria
          .filter((criterion) => criterion.text.trim() === "")
          .map((criterion) => `Criterion ${criterion.id} needs text.`),
        ...(schemaProblem(context.outputSchema) === null
          ? []
          : ["Correct the output schema."]),
        ...[
          { label: "Title", text: context.title },
          { label: "Brief", text: context.brief },
          ...context.tasks.flatMap((task) => [
            { label: `Task ${task.id} title`, text: task.title },
            { label: `Task ${task.id} instructions`, text: task.instructions },
          ]),
          ...context.criteria.map((criterion) => ({
            label: `Criterion ${criterion.id}`,
            text: criterion.text,
          })),
          { label: "Output schema", text: context.outputSchema },
        ].flatMap(({ label, text }) => {
          // This form promises {{name}} references; the converter owns substitution at cutover.
          const names = new Set(
            [...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) =>
              match[1]?.trim(),
            ),
          );
          return [...names].flatMap((name) =>
            name && !declaredParameters.has(name)
              ? [`${label} references undeclared parameter {{${name}}}.`]
              : [],
          );
        }),
      ];
      return errors.map((message) => ({
        selection: context.key,
        message: `${context.key}: ${message}`,
      }));
    }),
  ];
  const invalid = problems.length > 0;
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const selected =
    draft.contexts.find((context) => context.key === selection) ?? null;

  const save = async () => {
    if (pending || invalid || saveState !== "idle") return;
    const submitted = draft;
    setPending(true);
    setActionError(null);
    try {
      const acknowledgment = actions.onSave(submitted);
      if (acknowledgment === undefined) return;
      const snapshot = await acknowledgment;
      if (snapshot !== undefined) {
        setSaved(snapshot);
        setDraft((current) =>
          same(current, submitted)
            ? snapshot
            : {
                ...current,
                revision: snapshot.revision,
                updatedAt: snapshot.updatedAt,
              },
        );
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not save the template.",
      );
    } finally {
      setPending(false);
    }
  };

  const reload = async () => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      const snapshot = await actions.onReload();
      setSaved(snapshot);
      setDraft(snapshot);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not reload the template.",
      );
    } finally {
      setPending(false);
    }
  };

  const updateContext = (
    key: string,
    change: (context: TemplateContext) => TemplateContext,
  ) =>
    setDraft((current) => ({
      ...current,
      contexts: current.contexts.map((context) =>
        context.key === key ? change(context) : context,
      ),
    }));

  // A default reaches every context that has not set its own value.
  const setDefault = <K extends ConfigKey>(
    key: K,
    value: ConfigBlock[K]["value"],
    from: Tier,
  ) =>
    setDraft((current) => ({
      ...current,
      defaults: withSetting(current.defaults, key, value, from),
      contexts: current.contexts.map((context) =>
        context.config[key].from === "context"
          ? context
          : {
              ...context,
              config: withSetting(
                context.config,
                key,
                value,
                from === "global" ? "global" : "template",
              ),
            },
      ),
    }));

  const edges: RunEdge[] = draft.contexts.flatMap((context) =>
    context.dependsOn.map((from) => ({
      from,
      to: context.key,
      guard:
        context.guards[from] === undefined
          ? null
          : { label: context.guards[from], state: "undecided" as const },
      outputOnly: context.outputOnly.includes(from),
    })),
  );
  const loops = draft.loops.map((loop) => ({
    ...loop,
    pass: 0,
    state: "unstarted" as const,
  }));
  const lanes = draft.lanes.map((lane) => ({
    key: lane.key,
    branch: `lane ${lane.key}`,
    worktreePath: "",
    state: "waiting" as const,
    attempt: null,
    detail: null,
    commit: null,
    checks: lane.checks,
  }));

  return (
    <div className="flex h-full min-h-0 w-full bg-bg-void">
      <aside className="w-[248px] shrink-0 overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-dim bg-bg-base px-sm py-xl max-1080:hidden">
        <TemplatesRail
          templates={templates}
          selectedId={template.id}
          selectedTier={template.tier}
          disabled={total > 0 || pending}
          onSelect={actions.onSelectTemplate}
        />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-xl overflow-y-auto px-2xl py-xl max-768:px-lg">
          <div className="hidden max-1080:block">
            <Select
              value={`${template.tier}:${template.id}`}
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
          <header className="flex flex-wrap items-start gap-lg">
            <div className="flex min-w-0 flex-1 flex-col gap-sm max-768:basis-full">
              <span className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
                {template.tier === "project"
                  ? "Project template"
                  : "Global template"}{" "}
                · revision {saved.revision} · saved{" "}
                {formatLocalTime(saved.updatedAt)}
              </span>
              <h1 className="m-0 font-display text-[1.75rem] leading-[1.1] font-extrabold text-text-primary max-768:text-[1.35rem]">
                {draft.name}
              </h1>
              <p className="m-0 max-w-[720px] font-mono text-[0.75rem] leading-[1.55] text-text-secondary">
                {draft.description}
              </p>
              <span className="flex flex-wrap items-center gap-x-lg gap-y-[4px] font-mono text-[0.72rem] text-text-tertiary">
                <span>{draft.contexts.length} contexts</span>
                <span>{draft.lanes.length} lanes</span>
                <span>
                  {draft.loops.length}{" "}
                  {draft.loops.length === 1 ? "loop" : "loops"}
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
                  disabled={
                    total > 0 || pending || invalid || saveState !== "idle"
                  }
                  onClick={actions.onLaunch}
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
                  contexts={draft.contexts.map(asRunContext)}
                  edges={edges}
                  lanes={lanes}
                  loops={loops}
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
                    <SelectItem value="defaults">
                      Details and defaults
                    </SelectItem>
                    {draft.contexts.map((context) => (
                      <SelectItem key={context.key} value={context.key}>
                        {context.key} · {context.title}
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
                    selected={selection === "defaults"}
                    onSelect={() => setSelection("defaults")}
                    overline="template"
                    title="Details and defaults"
                    changed={counts.get("defaults") ?? 0}
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
                    <span className="font-normal">{draft.contexts.length}</span>
                  </h2>
                  <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                    {draft.contexts.map((context) => {
                      const set = overrides(context);
                      return (
                        <NavItem
                          key={context.key}
                          selected={selection === context.key}
                          onSelect={() => setSelection(context.key)}
                          overline={context.key}
                          title={context.title}
                          changed={counts.get(context.key) ?? 0}
                          trailing={
                            <>
                              {context.lane !== null ? (
                                <span
                                  className="text-text-tertiary"
                                  title={`lane ${context.lane}`}
                                >
                                  <BranchIcon size={11} />
                                </span>
                              ) : null}
                              {context.loop !== null ? (
                                <span
                                  className="text-text-tertiary"
                                  title={`loop ${context.loop}`}
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
                      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
                        Every context uses these unless it sets its own. Unset
                        ones come from the global defaults.
                      </p>
                    </div>
                    <ConfigFields
                      block={draft.defaults}
                      scope="template"
                      options={options}
                      onSet={(key, value) => setDefault(key, value, "template")}
                      onReset={(key) =>
                        setDefault(key, draft.globals[key], "global")
                      }
                    />
                    <FieldSection
                      title="Lane checks"
                      description="Run on each lane's merged tree before it publishes into the session branch."
                    >
                      {draft.lanes.map((lane) => (
                        <SettingRow key={lane.key} label={`Lane ${lane.key}`}>
                          <ChecksEditor
                            checks={lane.checks}
                            available={options.checks}
                            onChange={(checks) =>
                              setDraft((current) => ({
                                ...current,
                                lanes: current.lanes.map((other) =>
                                  other.key === lane.key
                                    ? { ...other, checks }
                                    : other,
                                ),
                              }))
                            }
                          />
                        </SettingRow>
                      ))}
                    </FieldSection>
                  </>
                ) : (
                  <>
                    <div className="flex flex-col gap-xs">
                      <span className="font-mono text-[0.7rem] text-cyan">
                        CONTEXT / {selected.key}
                      </span>
                      <h2 className="m-0 font-display text-[1.15rem] font-bold text-text-primary">
                        {selected.title}
                      </h2>
                    </div>
                    <Placement context={selected} template={draft} />
                    <ContentFields
                      context={selected}
                      onChange={(change) =>
                        updateContext(selected.key, (context) => ({
                          ...context,
                          ...change,
                        }))
                      }
                    />
                    <ConfigFields
                      block={selected.config}
                      scope="context"
                      options={options}
                      onSet={(key, value) =>
                        updateContext(selected.key, (context) => ({
                          ...context,
                          config: withSetting(
                            context.config,
                            key,
                            value,
                            "context",
                          ),
                        }))
                      }
                      onReset={(key) =>
                        updateContext(selected.key, (context) => {
                          const inherited = draft.defaults[key];
                          return {
                            ...context,
                            config: withSetting(
                              context.config,
                              key,
                              inherited.value,
                              inherited.from === "global"
                                ? "global"
                                : "template",
                            ),
                          };
                        })
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
            className="flex flex-wrap items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface px-2xl py-sm max-768:px-lg"
          >
            <span className="font-mono text-[0.72rem] text-red-text">
              Fix before saving:
            </span>
            {problems.map((problem, index) => (
              <button
                key={index}
                type="button"
                onClick={() => {
                  setSelection(problem.selection);
                  setView("edit");
                }}
                className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.72rem] text-red-text underline underline-offset-2 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {problem.message}
              </button>
            ))}
          </div>
        ) : null}
        {actionError !== null ? (
          <p
            role="alert"
            className="m-0 px-2xl py-sm font-mono text-[0.72rem] text-red-text"
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
          onDiscard={() => setDraft(saved)}
          onReload={() => {
            void reload();
          }}
          onSave={() => {
            void save();
          }}
        />
      </main>
    </div>
  );
}

/** A template switch begins a separate draft; a new saved revision keeps current edits. */
export function TemplateEditor(
  props: Parameters<typeof TemplateEditorBody>[0],
) {
  return (
    <TemplateEditorBody
      key={`${props.template.tier}:${props.template.id}`}
      {...props}
    />
  );
}
