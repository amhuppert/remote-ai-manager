"use client";

import { useId, useState } from "react";
import { MultilineInput } from "@/components/MultilineInput";
import { AlertTriangleIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import type { ContextHalt, Remedy } from "../model";
import {
  haltExplanation,
  haltTitle,
  remedy as presentRemedy,
} from "../present";

export interface RemedyChoice {
  occurrence: string;
  remedy: Remedy;
  note?: string;
  count?: number;
}

const TEXTAREA =
  "min-h-[64px] w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-[10px] py-[8px] font-mono text-[0.78rem] leading-[1.5] text-text-primary placeholder:text-text-tertiary focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none";

const COUNT_INPUT =
  "h-[30px] w-[64px] rounded-md border border-solid border-border-default bg-bg-base px-[8px] font-mono text-[0.78rem] text-text-primary focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] focus:outline-none";

function RemedyForm({
  choice,
  halt,
  runSuspended,
  submitting,
  onCancel,
  onSubmit,
}: {
  choice: Remedy;
  halt: ContextHalt;
  runSuspended: boolean;
  submitting: boolean;
  onCancel(): void;
  onSubmit(value: RemedyChoice): void;
}) {
  const presented = presentRemedy(choice, halt.kind, halt.seat);
  const [note, setNote] = useState("");
  const [count, setCount] = useState("1");
  const clampCount = () =>
    Math.min(9, Math.max(1, Math.trunc(Number(count)) || 1));
  const [missing, setMissing] = useState(false);
  const noteId = useId();
  const countId = useId();
  const placeholder =
    presented.needsNote === "evidence"
      ? "What shows it finished, e.g. the commit or the file it wrote"
      : "Why, for the run's record and the agents";
  return (
    <form
      aria-label="Apply remedy"
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitting) return;
        if (note.trim() === "") {
          setMissing(true);
          return;
        }
        onSubmit({
          occurrence: halt.occurrence,
          remedy: choice,
          note: note.trim(),
          ...(choice.kind === "grant" ? { count: clampCount() } : {}),
        });
      }}
    >
      <label
        htmlFor={noteId}
        className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase"
      >
        {presented.needsNote === "evidence" ? "Evidence" : "Reason"}
      </label>
      <MultilineInput
        id={noteId}
        className={TEXTAREA}
        value={note}
        disabled={submitting}
        placeholder={placeholder}
        aria-invalid={missing}
        aria-describedby={missing ? `${noteId}-error` : undefined}
        onValueChange={(value) => {
          setNote(value);
          setMissing(false);
        }}
        autoFocus
      />
      {missing ? (
        <span
          id={`${noteId}-error`}
          className="font-mono text-[0.72rem] text-red-text"
        >
          {presented.needsNote === "evidence"
            ? "Add the evidence first."
            : "Add a reason first."}
        </span>
      ) : null}
      <div className="flex flex-wrap items-center gap-sm">
        {choice.kind === "grant" ? (
          <label
            htmlFor={countId}
            className="flex items-center gap-sm font-mono text-[0.72rem] text-text-secondary"
          >
            More retries
            <input
              id={countId}
              className={COUNT_INPUT}
              type="number"
              min={1}
              max={9}
              value={count}
              disabled={submitting}
              onChange={(event) => setCount(event.target.value)}
              onBlur={() => setCount(String(clampCount()))}
            />
          </label>
        ) : null}
        <div className="ml-auto flex items-center gap-sm">
          <Button
            touch
            size="sm"
            variant="ghost"
            type="button"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            touch
            size="sm"
            variant="primary"
            type="submit"
            loading={submitting}
          >
            <span className="min-w-0 text-left whitespace-normal">
              {presented.label}
              {runSuspended ? " and resume run" : ""}
            </span>
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * A halted context: what stopped, why it stops the work, and each remedy the
 * engine offers beside what choosing it does. A remedy that needs a reason or
 * evidence asks for it inline before it applies.
 */
export function HaltCard({
  halt,
  submitting = false,
  runSuspended = false,
  onApply,
}: {
  halt: ContextHalt;
  submitting?: boolean;
  runSuspended?: boolean;
  onApply(choice: RemedyChoice): void;
}) {
  const [open, setOpen] = useState<Remedy["kind"] | null>(null);
  return (
    <section
      aria-label={`Halted: ${haltTitle(halt.kind)}`}
      className="overflow-hidden rounded-lg border border-solid border-[var(--cc-red-a40)] bg-bg-surface"
    >
      <header className="flex items-start gap-md border-x-0 border-t-0 border-b border-solid border-[var(--cc-red-a40)] bg-red-glow px-lg py-md">
        <span className="mt-[1px] text-red">
          <AlertTriangleIcon size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
          <div className="flex items-baseline gap-sm">
            <h3 className="m-0 font-mono text-[0.82rem] font-semibold text-red">
              {haltTitle(halt.kind)}
            </h3>
            <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-text-tertiary">
              {formatLocalTime(halt.at)}
            </span>
          </div>
          <p className="m-0 font-mono text-[0.78rem] leading-[1.5] text-text-primary">
            {halt.detail}
          </p>
          <p className="m-0 font-mono text-[0.72rem] leading-[1.5] text-text-secondary">
            {haltExplanation(halt.kind)}
          </p>
          {runSuspended ? (
            <p className="m-0 font-mono text-[0.72rem] leading-relaxed text-amber">
              Applying a remedy resumes the whole run, including other contexts.
            </p>
          ) : null}
        </div>
      </header>
      <ul className="m-0 flex list-none flex-col gap-0 p-0">
        {halt.remedies.map((choice) => {
          const presented = presentRemedy(choice, halt.kind, halt.seat);
          const isOpen = open === choice.kind;
          return (
            <li
              key={choice.kind}
              className={cn(
                "flex flex-col gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md last:border-b-0",
                isOpen && "bg-bg-raised",
              )}
            >
              <div className="flex items-start gap-md max-640:flex-col max-640:items-stretch">
                <Button
                  touch
                  size="sm"
                  variant={
                    presented.emphasis === "primary" ? "primary" : "default"
                  }
                  layoutClassName="w-[184px] shrink-0 max-640:w-full"
                  aria-expanded={
                    presented.needsNote !== null ? isOpen : undefined
                  }
                  loading={submitting && presented.needsNote === null}
                  disabled={submitting}
                  onClick={() => {
                    if (presented.needsNote === null)
                      onApply({ occurrence: halt.occurrence, remedy: choice });
                    else setOpen(isOpen ? null : choice.kind);
                  }}
                >
                  <span className="min-w-0 text-left whitespace-normal">
                    {presented.label}
                    {runSuspended ? " and resume run" : ""}
                    {presented.needsNote !== null ? (
                      <span aria-hidden="true">…</span>
                    ) : null}
                  </span>
                </Button>
                <p className="m-0 pt-[5px] font-mono text-[0.72rem] leading-[1.5] text-text-secondary max-640:pt-0">
                  {presented.consequence}
                </p>
              </div>
              {isOpen ? (
                <RemedyForm
                  choice={choice}
                  halt={halt}
                  runSuspended={runSuspended}
                  submitting={submitting}
                  onCancel={() => setOpen(null)}
                  onSubmit={onApply}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
