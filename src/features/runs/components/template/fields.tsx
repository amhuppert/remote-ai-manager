"use client";

import { useId, useState } from "react";
import { MultilineInput } from "@/components/MultilineInput";
import { CloseIcon, PlusIcon, UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
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
import { WithTooltip } from "@/components/ui/WithTooltip";
import type { SettingsTier } from "@/lib/config/settings-cascade";
import { findBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import type { ProjectBackendModelOptions } from "@/lib/agent-backends/project-model-options-schema";
import type {
  AgentProfileLibraryItem,
  AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import {
  DEFAULT_REVIEWER_PROFILE,
  type ReviewerSetting,
} from "@/lib/runs/settings";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";
import { BackendDiamond } from "../parts";
import {
  catalogFor,
  effortParameterOf,
  modelOf,
  profileKey,
  profileRefOf,
  seatOf,
  withBackend,
  withEffort,
  withModel,
  type Seat,
} from "../../seat-model";

/**
 * The editor's field kit: a setting row that states which tier its value
 * comes from, and the controls for seats, reviewers, checks and lists.
 */

/** A text field's box; the caller sets its width. */
export const FIELD =
  "rounded-md border border-solid border-border-default bg-bg-base px-[10px] py-[7px] font-mono text-[0.78rem] text-text-primary transition-[border-color,box-shadow] duration-150 placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none";

export const INPUT = cn(FIELD, "w-full");

export const TEXTAREA = cn(FIELD, "w-full resize-y leading-[1.55]");

/** What the editor offers a seat, a reviewer and a check. */
export interface TemplateEditorOptions {
  /** The project's model options by backend. */
  models: readonly ProjectBackendModelOptions[];
  /** Profiles a seat may name; a global template's are the builtin and global tiers. */
  profiles: readonly AgentProfileLibraryItem[];
  /** Validation commands a check may name. */
  checks: readonly string[];
}

type NumberFieldProps = {
  label: string;
  min: number;
} & (
  | { value: number; nullable?: false; onChange(value: number): void }
  | {
      value: number | null;
      nullable: true;
      onChange(value: number | null): void;
    }
);

/**
 * Keeps keystrokes local and commits a changed value as a whole number on
 * blur. Only typing starts a local draft: an untouched field, focused or not,
 * shows the current value and writes nothing, so an inherited value stays
 * inherited.
 */
export function NumberField(props: NumberFieldProps) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown = props.value === null ? "" : String(props.value);
  return (
    <input
      type="number"
      min={props.min}
      step={1}
      aria-label={props.label}
      className={cn(FIELD, "w-[72px] text-right")}
      placeholder={props.nullable ? "None" : undefined}
      value={raw ?? shown}
      onChange={(event) => setRaw(event.target.value)}
      onBlur={() => {
        const text = raw;
        setRaw(null);
        if (text === null || text === shown) return;
        if (props.nullable && text.trim() === "") {
          props.onChange(null);
          return;
        }
        const number = Number(text);
        const value = Number.isFinite(number)
          ? Math.max(props.min, Math.floor(number))
          : props.min;
        if (value !== props.value) props.onChange(value);
      }}
    />
  );
}

const TIER_LABEL: Record<SettingsTier, string> = {
  global: "Command Center",
  template: "template",
  context: "context",
};

/** Where a value comes from, and the way back to the one it would inherit. */
export function TierBadge({
  from,
  scope,
  resetLabel,
  onReset,
}: {
  from: SettingsTier;
  /** The tier being edited: a context, or the template's defaults. */
  scope: "context" | "template";
  /** What a reset falls back to, e.g. "Use the template default". */
  resetLabel: string;
  onReset(): void;
}) {
  if (from !== scope)
    return (
      <StatusChip
        tone="neutral"
        title={
          from === "global"
            ? "Inherited from the Command Center defaults"
            : "Inherited from this template's defaults"
        }
      >
        {TIER_LABEL[from]}
      </StatusChip>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-[4px]">
      <StatusChip
        tone="cyan"
        icon={
          <span
            aria-hidden="true"
            className="size-[5px] rounded-full bg-cyan"
          />
        }
      >
        set here
      </StatusChip>
      <WithTooltip label={resetLabel}>
        <button
          type="button"
          aria-label={resetLabel}
          onClick={onReset}
          className="inline-flex size-[22px] cursor-pointer items-center justify-center rounded-sm border border-solid border-transparent bg-transparent text-text-tertiary transition-colors duration-150 hover:border-border-default hover:bg-bg-hover hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          <UndoIcon size={12} />
        </button>
      </WithTooltip>
    </span>
  );
}

/** A card of related fields, with its tier when the whole block is one setting. */
export function FieldSection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <header className="flex items-start gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h3 className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
            {title}
          </h3>
          {description !== undefined ? (
            <p className="m-0 font-mono text-[0.72rem] leading-[1.5] text-text-tertiary">
              {description}
            </p>
          ) : null}
        </div>
        {badge}
      </header>
      <div className="flex flex-col gap-lg px-lg py-lg">{children}</div>
    </section>
  );
}

/** One labelled setting: its name and explanation, its control, its tier. */
export function SettingRow({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div
      className="flex items-center gap-lg max-768:flex-col max-768:items-stretch max-768:gap-sm"
      role="group"
      aria-labelledby={id}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span
          id={id}
          className="font-mono text-[0.78rem] font-medium text-text-primary"
        >
          {label}
        </span>
        {hint !== undefined ? (
          <span className="font-mono text-[0.72rem] leading-[1.45] text-text-tertiary">
            {hint}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-md">
        {children}
        {badge !== undefined ? (
          <span className="flex w-[124px] justify-end max-768:w-auto">
            {badge}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled control in a grid of seat fields. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[6px]">
      <span
        aria-hidden="true"
        className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

interface Choice {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

function ChoiceSelect({
  label,
  value,
  choices,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  disabled?: boolean;
  onChange(next: string): void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} layoutClassName="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem
            key={choice.value}
            value={choice.value}
            disabled={choice.disabled}
          >
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const DEFAULT = "__default";

function backendLabel(backend: AgentBackendId): string {
  return findBackendCatalogEntry(backend)?.label ?? backend;
}

function BackendName({ backend }: { backend: AgentBackendId }) {
  return (
    <span className="inline-flex items-center gap-[6px]">
      <BackendDiamond backend={backend} />
      {backendLabel(backend)}
    </span>
  );
}

/** The backend, model and effort of one seat; each left to its default until chosen. */
export function SeatFields({
  seat,
  options,
  onChange,
  children,
}: {
  seat: Seat;
  options: TemplateEditorOptions;
  onChange(next: Seat): void;
  /** Further fields in the same grid, such as the seat's profile. */
  children?: React.ReactNode;
}) {
  const backends = options.models.map((entry) => entry.backend);
  const catalog = catalogFor(options.models, seat.backend);
  const selection = seat.modelSelection;
  const model =
    catalog === null || selection === undefined
      ? null
      : modelOf(catalog, selection.modelId);
  const effort =
    catalog === null || model === null
      ? null
      : effortParameterOf(catalog, model.id);

  const backendChoices: Choice[] = [
    { value: DEFAULT, label: "Command Center default" },
    ...(seat.backend !== undefined && !backends.includes(seat.backend)
      ? [
          {
            value: seat.backend,
            label: `${backendLabel(seat.backend)} · unavailable`,
            disabled: true,
          },
        ]
      : []),
    ...backends.map((backend) => ({
      value: backend,
      label: <BackendName backend={backend} />,
    })),
  ];
  const modelChoices: Choice[] =
    seat.backend === undefined
      ? [
          selection === undefined
            ? { value: DEFAULT, label: "Command Center default" }
            : { value: selection.modelId, label: selection.modelId },
        ]
      : [
          { value: DEFAULT, label: `${backendLabel(seat.backend)} default` },
          ...(selection !== undefined && model === null
            ? [
                {
                  value: selection.modelId,
                  label: `${selection.modelId} · unavailable`,
                  disabled: true,
                },
              ]
            : []),
          ...(catalog?.models ?? []).map((option) => ({
            value: option.id,
            label: option.label,
          })),
        ];
  const effortValue =
    effort === null || selection === undefined
      ? DEFAULT
      : (selection.parameters[effort.id] ?? DEFAULT);
  const effortChoices: Choice[] =
    effort === null
      ? [
          {
            value: DEFAULT,
            label: selection === undefined ? "Model default" : "None",
          },
        ]
      : effort.values.map((value) => ({
          value: value.value,
          label: value.label,
        }));

  return (
    <div className="grid grid-cols-2 gap-md max-768:grid-cols-1">
      <Field label="Backend">
        <ChoiceSelect
          label="Backend"
          value={seat.backend ?? DEFAULT}
          choices={backendChoices}
          onChange={(next) =>
            onChange(
              withBackend(
                seat,
                next === DEFAULT
                  ? null
                  : (backends.find((backend) => backend === next) ?? null),
              ),
            )
          }
        />
      </Field>
      <Field label="Model">
        <ChoiceSelect
          label="Model"
          // An authored alias shows as the catalog model it names; the document keeps the alias until an edit.
          value={model?.id ?? selection?.modelId ?? DEFAULT}
          choices={modelChoices}
          disabled={seat.backend === undefined}
          onChange={(next) => {
            if (catalog === null) return;
            onChange(withModel(seat, catalog, next === DEFAULT ? null : next));
          }}
        />
      </Field>
      <Field label={effort?.label ?? "Effort"}>
        <ChoiceSelect
          label={effort?.label ?? "Effort"}
          value={effortValue}
          choices={effortChoices}
          disabled={effort === null}
          onChange={(next) => {
            if (catalog === null) return;
            onChange(withEffort(seat, catalog, next));
          }}
        />
      </Field>
      {children}
    </div>
  );
}

/** A seat's agent profile, as a qualified reference. */
export function ProfileField({
  value,
  profiles,
  onChange,
}: {
  value: AgentProfileRef;
  profiles: readonly AgentProfileLibraryItem[];
  onChange(next: AgentProfileRef): void;
}) {
  const key = profileKey(value);
  const listed = profiles.some((profile) => profileKey(profile.ref) === key);
  return (
    <Field label="Profile">
      <ChoiceSelect
        label="Profile"
        value={key}
        choices={[
          ...(listed
            ? []
            : [{ value: key, label: `${key} · unavailable`, disabled: true }]),
          ...profiles.map((profile) => ({
            value: profileKey(profile.ref),
            label: `${profile.name} · ${profile.ref.tier}`,
          })),
        ]}
        onChange={(next) => {
          const ref = profileRefOf(next);
          if (ref !== null) onChange(ref);
        }}
      />
    </Field>
  );
}

/** The reviewer list: each reviewer's authority, focus, seat and profile. */
export function ReviewersEditor({
  reviewers,
  options,
  onChange,
}: {
  reviewers: readonly ReviewerSetting[];
  options: TemplateEditorOptions;
  onChange(next: ReviewerSetting[]): void;
}) {
  const update = (
    index: number,
    change: (r: ReviewerSetting) => ReviewerSetting,
  ) =>
    onChange(
      reviewers.map((reviewer, at) =>
        at === index ? change(reviewer) : reviewer,
      ),
    );
  return (
    <div className="flex flex-col gap-md">
      {reviewers.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
          No agent reviews. Checks and any human approval still apply.
        </p>
      ) : null}
      {reviewers.map((reviewer, index) => (
        <div
          // Reviewers have no identity of their own; their position is it.
          key={index}
          role="group"
          aria-label={`Reviewer ${index + 1}`}
          className="flex flex-col gap-md rounded-md border border-solid border-border-dim bg-bg-base p-md"
        >
          <div className="flex flex-wrap items-center gap-md">
            <span className="font-mono text-[0.72rem] font-semibold text-text-secondary">
              Reviewer {index + 1}
            </span>
            <SegmentedControl
              value={reviewer.authority}
              aria-label="Authority"
              onValueChange={(value) =>
                update(index, (current) => ({
                  ...current,
                  authority: value === "advisory" ? "advisory" : "blocking",
                }))
              }
            >
              <SegmentedControlItem value="blocking">
                Blocking
              </SegmentedControlItem>
              <SegmentedControlItem value="advisory">
                Advisory
              </SegmentedControlItem>
            </SegmentedControl>
            <input
              aria-label="Focus"
              className={cn(FIELD, "min-w-[160px] flex-1")}
              value={reviewer.focus ?? ""}
              placeholder="Focus, e.g. Correctness"
              onChange={(event) => {
                const focus = event.target.value;
                update(index, (current) => {
                  const next: ReviewerSetting = { ...current, focus };
                  if (focus.trim() === "") delete next.focus;
                  return next;
                });
              }}
            />
            <WithTooltip label="Remove reviewer">
              <IconButton
                variant="ghost"
                tone="danger"
                aria-label={`Remove reviewer ${index + 1}`}
                onClick={() =>
                  onChange(reviewers.filter((_, at) => at !== index))
                }
              >
                <CloseIcon />
              </IconButton>
            </WithTooltip>
          </div>
          <SeatFields
            seat={seatOf(reviewer)}
            options={options}
            onChange={(seat) =>
              update(index, (current) => ({
                authority: current.authority,
                ...(current.focus === undefined
                  ? {}
                  : { focus: current.focus }),
                profile: current.profile,
                ...seat,
              }))
            }
          >
            <ProfileField
              value={reviewer.profile}
              profiles={options.profiles}
              onChange={(profile) =>
                update(index, (current) => ({ ...current, profile }))
              }
            />
          </SeatFields>
        </div>
      ))}
      <Button
        size="sm"
        variant="default"
        layoutClassName="self-start"
        onClick={() =>
          onChange([
            ...reviewers,
            { authority: "blocking", profile: DEFAULT_REVIEWER_PROFILE },
          ])
        }
      >
        <PlusIcon size={12} />
        Add reviewer
      </Button>
    </div>
  );
}

/** The selected validation commands, as removable chips with an add picker. */
export function ChecksEditor({
  checks,
  available,
  label = "Add a check",
  onChange,
}: {
  checks: readonly string[];
  available: readonly string[];
  label?: string;
  onChange(next: string[]): void;
}) {
  const remaining = available.filter((command) => !checks.includes(command));
  return (
    <div className="flex flex-wrap items-center gap-sm">
      {checks.map((command) => (
        <span
          key={command}
          className="inline-flex items-center gap-[4px] rounded-full border border-solid border-border-subtle bg-bg-raised py-px pr-[3px] pl-[10px] font-mono text-[0.72rem] text-text-primary"
        >
          {command}
          <button
            type="button"
            aria-label={`Remove ${command}`}
            onClick={() =>
              onChange(checks.filter((other) => other !== command))
            }
            className="inline-flex size-[20px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-tertiary hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-1"
          >
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
      {remaining.length > 0 ? (
        <Select
          value=""
          onValueChange={(command) => onChange([...checks, command])}
        >
          <SelectTrigger aria-label={label} layoutClassName="w-[150px]">
            <SelectValue placeholder="Add a check" />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((command) => (
              <SelectItem key={command} value={command}>
                {command}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {checks.length === 0 ? (
        <span className="font-mono text-[0.72rem] text-text-tertiary">
          No checks.
        </span>
      ) : null}
    </div>
  );
}

export interface ListItem {
  text: string;
  instructions: string;
}

/** An ordered list of short text items, each removable, with an add row; tasks also carry instructions. */
export function ListEditor({
  items,
  noun,
  placeholder,
  onChange,
  instructions = false,
}: {
  items: readonly ListItem[];
  /** What one item is, e.g. "Task": it names each item's field. */
  noun: string;
  placeholder: string;
  onChange(next: ListItem[]): void;
  instructions?: boolean;
}) {
  const replace = (index: number, change: Partial<ListItem>) =>
    onChange(
      items.map((item, at) => (at === index ? { ...item, ...change } : item)),
    );
  return (
    <ol className="m-0 flex list-none flex-col gap-sm p-0">
      {items.map((item, index) => (
        // Items have no identity of their own; their position is it.
        <li key={index} className="flex flex-col gap-sm">
          <div className="flex items-center gap-sm">
            <span className="w-[22px] shrink-0 text-right font-mono text-[0.7rem] text-text-tertiary">
              {index + 1}
            </span>
            <input
              aria-label={`${noun} ${index + 1}`}
              className={INPUT}
              value={item.text}
              placeholder={placeholder}
              onChange={(event) => replace(index, { text: event.target.value })}
            />
            <WithTooltip label={`Remove ${noun.toLowerCase()}`}>
              <IconButton
                variant="ghost"
                aria-label={`Remove ${noun.toLowerCase()} ${index + 1}`}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
              >
                <CloseIcon />
              </IconButton>
            </WithTooltip>
          </div>
          {instructions ? (
            <details className="ml-[30px] rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <summary className="cursor-pointer font-mono text-[0.7rem] text-text-secondary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2">
                Instructions for {noun.toLowerCase()} {index + 1}
                {item.instructions !== "" ? (
                  <span className="ml-sm text-text-tertiary">· added</span>
                ) : null}
              </summary>
              <MultilineInput
                aria-label={`${noun} ${index + 1} instructions`}
                className={cn(TEXTAREA, "mt-sm min-h-[80px]")}
                value={item.instructions}
                placeholder="Optional details for this task"
                onValueChange={(text) => replace(index, { instructions: text })}
              />
            </details>
          ) : null}
        </li>
      ))}
      <li>
        <Button
          size="sm"
          variant="ghost"
          layoutClassName="-ml-[12px]"
          onClick={() => onChange([...items, { text: "", instructions: "" }])}
        >
          <PlusIcon size={12} />
          Add {noun.toLowerCase()}
        </Button>
      </li>
    </ol>
  );
}
