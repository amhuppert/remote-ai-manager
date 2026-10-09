"use client";

import { useId, useState } from "react";
import { CloseIcon, PlusIcon, UndoIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { findBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";
import { BackendDiamond } from "../parts";
import type { CatalogOption, ReviewerConfig, SeatConfig, Tier } from "../../template-model";

/**
 * The editor's field kit: a setting row that states where its value comes
 * from, and the controls for seats, reviewers, checks and ordered lists.
 */

/** A text field's box; the caller sets its width. */
export const FIELD =
  "rounded-md border border-solid border-border-default bg-bg-base px-[10px] py-[7px] font-mono text-[0.78rem] text-text-primary transition-[border-color,box-shadow] duration-150 placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none";

export const INPUT = cn(FIELD, "w-full");

export const TEXTAREA = cn(FIELD, "w-full resize-y leading-[1.55]");

type NumberFieldProps = {
  label: string;
  min: number;
} & (
  | { value: number; nullable?: false; onChange(value: number): void }
  | { value: number | null; nullable: true; onChange(value: number | null): void }
);

/** Keep intermediate keystrokes local; the setting is committed as an integer on blur. */
export function NumberField(props: NumberFieldProps) {
  const [raw, setRaw] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={props.min}
      step={1}
      aria-label={props.label}
      className={cn(FIELD, "w-[72px] text-right")}
      placeholder={props.nullable ? "None" : undefined}
      value={raw ?? props.value ?? ""}
      onFocus={() => setRaw(props.value === null ? "" : String(props.value))}
      onChange={(event) => setRaw(event.target.value)}
      onBlur={(event) => {
        const text = event.target.value;
        setRaw(null);
        if (props.nullable && text.trim() === "") {
          if (props.value !== null) props.onChange(null);
          return;
        }
        const number = Number(text);
        const value = Number.isFinite(number) ? Math.max(props.min, Math.floor(number)) : props.min;
        if (value !== props.value) props.onChange(value);
      }}
    />
  );
}

/** Where a value comes from, and the way back to the inherited one. */
export function TierBadge({
  from,
  scope,
  onReset,
}: {
  from: Tier;
  /** The tier being edited: a context, or the template's defaults. */
  scope: "context" | "template";
  onReset(): void;
}) {
  const setHere = from === scope;
  if (!setHere)
    return (
      <span
        className="inline-flex shrink-0 items-center rounded-sm border border-solid border-border-default px-[6px] py-px font-mono text-[0.7rem] text-text-tertiary"
        title={from === "global" ? "Inherited from the global defaults" : "Inherited from this template's defaults"}
      >
        {from === "global" ? "global" : "template"}
      </span>
    );
  const back = scope === "context" ? "Use the template default" : "Use the global default";
  return (
    <span className="inline-flex shrink-0 items-center gap-[4px]">
      <span className="inline-flex items-center gap-[5px] rounded-sm border border-solid border-[var(--cc-cyan-a25)] bg-cyan-glow px-[6px] py-px font-mono text-[0.7rem] text-cyan">
        <span className="size-[5px] rounded-full bg-cyan" />
        set here
      </span>
      <WithTooltip label={back}>
        <button
          type="button"
          aria-label={back}
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
    <section className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface">
      <header className="flex items-start gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h3 className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">{title}</h3>
          {description !== undefined ? (
            <p className="m-0 font-mono text-[0.72rem] leading-[1.5] text-text-tertiary">{description}</p>
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
    <div className="flex items-center gap-lg max-768:flex-col max-768:items-stretch max-768:gap-sm" role="group" aria-labelledby={id}>
      <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span id={id} className="font-mono text-[0.78rem] font-medium text-text-primary">
          {label}
        </span>
        {hint !== undefined ? <span className="font-mono text-[0.72rem] leading-[1.45] text-text-tertiary">{hint}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-md">
        {children}
        <span className="flex w-[118px] justify-end max-768:w-auto">{badge}</span>
      </div>
    </div>
  );
}

/** A labelled control in a grid of seat fields. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-[6px]">
      <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">{label}</span>
      {children}
    </label>
  );
}

function OptionSelect({
  value,
  options,
  label,
  onChange,
}: {
  value: string;
  options: readonly string[];
  label: string;
  onChange(next: string): void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} layoutClassName="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {!options.includes(value) && value !== "" ? <SelectItem value={value} disabled>{value} · unavailable</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BackendChoice({
  value,
  catalog,
  onChange,
}: {
  value: AgentBackendId;
  catalog: readonly CatalogOption[];
  onChange(next: AgentBackendId): void;
}) {
  return (
    <SegmentedControl
      value={value}
      aria-label="Backend"
      layoutClassName="self-start"
      onValueChange={(next) => {
        const option = catalog.find((entry) => entry.backend === next);
        if (option !== undefined) onChange(option.backend);
      }}
    >
      {catalog.map((entry) => (
        <SegmentedControlItem
          key={entry.backend}
          value={entry.backend}
          tone={findBackendCatalogEntry(entry.backend)?.toneToken === "violet" ? "violet" : "cyan"}
        >
          <BackendDiamond backend={entry.backend} />
          {findBackendCatalogEntry(entry.backend)?.label ?? entry.backend}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** Backend, model, effort and profile for one seat; changing the backend picks its first model. */
export function SeatFields({
  seat,
  catalog,
  efforts,
  profiles,
  onChange,
  showProfile = true,
}: {
  seat: Pick<SeatConfig, "backend" | "model" | "effort"> & { profile?: string };
  catalog: readonly CatalogOption[];
  efforts: readonly string[];
  profiles: readonly string[];
  onChange(next: Pick<SeatConfig, "backend" | "model" | "effort"> & { profile?: string }): void;
  showProfile?: boolean;
}) {
  const entry = catalog.find((option) => option.backend === seat.backend);
  const models = entry?.models ?? [];
  const supportedEfforts = entry?.effortsByModel?.[seat.model] ?? efforts;
  const selectModel = (backend: AgentBackendId, model: string) => {
    const levels = catalog.find((option) => option.backend === backend)?.effortsByModel?.[model] ?? efforts;
    onChange({ ...seat, backend, model, effort: levels.includes(seat.effort) ? seat.effort : levels[0] ?? "" });
  };
  return (
    <div className="flex flex-col gap-md">
      <BackendChoice
        value={seat.backend}
        catalog={catalog}
        onChange={(backend) =>
          selectModel(backend, catalog.find((entry) => entry.backend === backend)?.models[0] ?? "")
        }
      />
      <div className={cn("grid gap-md max-768:grid-cols-1", showProfile ? "grid-cols-3" : "grid-cols-2")}>
        <Field label="Model">
          <OptionSelect value={seat.model} options={models} label="Model" onChange={(model) => selectModel(seat.backend, model)} />
        </Field>
        <Field label="Effort">
          <OptionSelect value={seat.effort} options={supportedEfforts} label="Effort" onChange={(effort) => onChange({ ...seat, effort })} />
        </Field>
        {showProfile && seat.profile !== undefined ? (
          <Field label="Profile">
            <OptionSelect
              value={seat.profile}
              options={profiles}
              label="Profile"
              onChange={(profile) => onChange({ ...seat, profile })}
            />
          </Field>
        ) : null}
      </div>
    </div>
  );
}

/** The review cohort: each reviewer's authority, focus and seat. */
export function ReviewersEditor({
  reviewers,
  catalog,
  efforts,
  profiles,
  onChange,
}: {
  reviewers: ReviewerConfig[];
  catalog: readonly CatalogOption[];
  efforts: readonly string[];
  profiles: readonly string[];
  onChange(next: ReviewerConfig[]): void;
}) {
  const update = (id: string, change: Partial<ReviewerConfig>) =>
    onChange(reviewers.map((reviewer) => (reviewer.id === id ? { ...reviewer, ...change } : reviewer)));
  return (
    <div className="flex flex-col gap-md">
      {reviewers.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
          No agent reviews. Checks and any human approval still apply.
        </p>
      ) : null}
      {reviewers.map((reviewer, index) => (
        <div key={reviewer.id} className="flex flex-col gap-md rounded-md border border-solid border-border-dim bg-bg-base p-md">
          <div className="flex flex-wrap items-center gap-md">
            <span className="font-mono text-[0.72rem] font-semibold text-text-secondary">Reviewer {index + 1}</span>
            <SegmentedControl
              value={reviewer.authority}
              aria-label="Authority"
              onValueChange={(value) => update(reviewer.id, { authority: value === "advisory" ? "advisory" : "blocking" })}
            >
              <SegmentedControlItem value="blocking">Blocking</SegmentedControlItem>
              <SegmentedControlItem value="advisory">Advisory</SegmentedControlItem>
            </SegmentedControl>
            <input
              aria-label="Focus"
              className={cn(FIELD, "min-w-[160px] flex-1")}
              value={reviewer.focus}
              placeholder="Focus, e.g. Correctness"
              onChange={(event) => update(reviewer.id, { focus: event.target.value })}
            />
            <WithTooltip label="Remove reviewer">
              <IconButton
                variant="ghost"
                tone="danger"
                aria-label={`Remove reviewer ${index + 1}`}
                onClick={() => onChange(reviewers.filter((other) => other.id !== reviewer.id))}
              >
                <CloseIcon />
              </IconButton>
            </WithTooltip>
          </div>
          <SeatFields
            seat={reviewer}
            catalog={catalog}
            efforts={efforts}
            profiles={profiles}
            onChange={(seat) => update(reviewer.id, { ...seat, profile: seat.profile ?? reviewer.profile })}
          />
        </div>
      ))}
      <Button
        size="sm"
        variant="default"
        layoutClassName="self-start"
        onClick={() =>
          onChange([
            ...reviewers,
            {
              id: `r-${reviewers.length + 1}-${Date.now()}`,
              authority: "blocking",
              profile: profiles.find((profile) => profile === "builtin:general-reviewer") ?? profiles[0] ?? "builtin:general-reviewer",
              focus: "",
              backend: catalog[0]?.backend ?? "claude",
              model: catalog[0]?.models[0] ?? "",
              effort: "medium",
            },
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
  onChange,
}: {
  checks: string[];
  available: readonly string[];
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
            onClick={() => onChange(checks.filter((other) => other !== command))}
            className="inline-flex size-[20px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-tertiary hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-1"
          >
            <CloseIcon size={10} />
          </button>
        </span>
      ))}
      {remaining.length > 0 ? (
        <Select value="" onValueChange={(command) => onChange([...checks, command])}>
          <SelectTrigger aria-label="Add a check" layoutClassName="w-[150px]">
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
      {checks.length === 0 ? <span className="font-mono text-[0.72rem] text-text-tertiary">No checks.</span> : null}
    </div>
  );
}

/** An ordered list of short text items, each removable, with an add row. */
export function ListEditor({
  items,
  idPrefix,
  addLabel,
  placeholder,
  onChange,
  instructions = false,
}: {
  items: Array<{ id: string; text: string; instructions?: string }>;
  idPrefix: string;
  addLabel: string;
  placeholder: string;
  onChange(next: Array<{ id: string; text: string; instructions?: string }>): void;
  instructions?: boolean;
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-sm p-0">
      {items.map((item, index) => (
        <li key={item.id} className="flex flex-col gap-sm">
          <div className="flex items-center gap-sm">
          <span className="w-[34px] shrink-0 font-mono text-[0.7rem] text-text-tertiary">{item.id}</span>
          <input
            aria-label={`${addLabel.replace(/^Add /, "")} ${index + 1}`}
            className={INPUT}
            value={item.text}
            placeholder={placeholder}
            onChange={(event) =>
              onChange(items.map((other) => (other.id === item.id ? { ...other, text: event.target.value } : other)))
            }
          />
          <WithTooltip label="Remove">
            <IconButton
              variant="ghost"
              aria-label={`Remove ${item.id}`}
              onClick={() => onChange(items.filter((other) => other.id !== item.id))}
            >
              <CloseIcon />
            </IconButton>
          </WithTooltip>
          </div>
          {instructions ? (
            <details className="ml-[42px] rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm">
              <summary className="cursor-pointer font-mono text-[0.7rem] text-text-secondary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2">
                Instructions for {item.id}
                {item.instructions ? <span className="ml-sm text-text-tertiary">· added</span> : null}
              </summary>
              <textarea
                aria-label={`Task ${item.id} instructions`}
                className={cn(TEXTAREA, "mt-sm min-h-[80px]")}
                value={item.instructions ?? ""}
                placeholder="Optional details for this task"
                onChange={(event) => onChange(items.map((other) => other.id === item.id ? { ...other, instructions: event.target.value } : other))}
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
          onClick={() => {
            let next = items.length + 1;
            while (items.some((item) => item.id === `${idPrefix}${next}`)) next += 1;
            onChange([...items, { id: `${idPrefix}${next}`, text: "" }]);
          }}
        >
          <PlusIcon size={12} />
          {addLabel}
        </Button>
      </li>
    </ol>
  );
}
