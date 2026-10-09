import { useRef, useState } from "react";
import { AlertTriangleIcon, CheckIcon, CloseIcon } from "@/components/icons";
import { StatusDot } from "@/components/ui/StatusDot";
import { findBackendCatalogEntry } from "@/lib/agent-backends/catalog";
import { cn } from "@/lib/ui/cn";
import {
  ApprovalIcon,
  PauseIcon,
  QuestionIcon,
  SkippedIcon,
  WaitingIcon,
} from "../icons";
import type { ContextState, SeatSummary } from "../model";
import { formatUsd } from "../present";

/** The state of a context as one glyph, the same everywhere it appears. */
export function ContextGlyph({
  state,
  size = 14,
}: {
  state: ContextState;
  size?: number;
}) {
  const box = "inline-flex shrink-0 items-center justify-center";
  switch (state.kind) {
    case "running":
    case "stopping":
      return (
        <span className={cn(box, "size-[14px]")}>
          <StatusDot tone="cyan" />
        </span>
      );
    case "awaiting_approval":
      return (
        <span className={cn(box, "text-amber")}>
          <ApprovalIcon size={size} />
        </span>
      );
    case "awaiting_answer":
      return (
        <span className={cn(box, "text-amber")}>
          <QuestionIcon size={size} />
        </span>
      );
    case "halted":
      return (
        <span className={cn(box, "text-red")}>
          <AlertTriangleIcon size={size} />
        </span>
      );
    case "succeeded":
      return (
        <span className={cn(box, "text-green")}>
          <CheckIcon size={size} />
        </span>
      );
    case "paused":
      return (
        <span className={cn(box, "text-text-secondary")}>
          <PauseIcon size={size} />
        </span>
      );
    case "cancelled":
      return (
        <span className={cn(box, "text-text-tertiary")}>
          <CloseIcon size={size - 2} />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(box, "text-text-tertiary")}>
          <SkippedIcon size={size} />
        </span>
      );
    case "waiting":
      return (
        <span className={cn(box, "text-text-tertiary")}>
          <WaitingIcon size={size} />
        </span>
      );
  }
}

const backendTone: Record<string, string> = {
  cyan: "text-cyan",
  violet: "text-violet",
};

/** A backend's identity diamond, coloured by the catalog's tone. */
export function BackendDiamond({
  backend,
}: {
  backend: SeatSummary["backend"];
}) {
  const tone = findBackendCatalogEntry(backend)?.toneToken;
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        "shrink-0",
        (tone !== undefined ? backendTone[tone] : undefined) ??
          "text-text-secondary",
      )}
    >
      <path d="M8 1.6 14.4 8 8 14.4 1.6 8Z" fill="currentColor" />
    </svg>
  );
}

/** A seat's model in the backend's identity colour, with its effort. */
export function SeatMark({
  seat,
  showEffort = true,
}: {
  seat: SeatSummary;
  showEffort?: boolean;
}) {
  const label = findBackendCatalogEntry(seat.backend)?.label ?? seat.backend;
  return (
    <span
      className="inline-flex min-w-0 items-center gap-[6px] font-mono text-[0.72rem] text-text-secondary"
      title={`${label} ${seat.model}${seat.effort !== null ? ` · ${seat.effort} effort` : ""}`}
    >
      <BackendDiamond backend={seat.backend} />
      <span className="truncate text-text-primary">{seat.model}</span>
      {showEffort && seat.effort !== null ? (
        <span className="text-text-tertiary">{seat.effort}</span>
      ) : null}
    </span>
  );
}

/** An UPPERCASE label over its value, as metadata strips write it. */
export function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <span className="font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-[0.78rem] text-text-primary">
        {children}
      </span>
    </div>
  );
}

/** A context key as code: how the definition and agents name it. */
export function KeyLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.72rem] font-medium text-text-tertiary">
      {children}
    </span>
  );
}

/** Section title for panels: UPPERCASE mono with an optional count and trailing slot. */
export function PanelHeading({
  children,
  count,
  trailing,
}: {
  children: React.ReactNode;
  count?: number | string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[24px] items-center gap-sm">
      <h3 className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
        {children}
      </h3>
      {count !== undefined ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {count}
        </span>
      ) : null}
      {trailing !== undefined ? (
        <div className="ml-auto flex items-center gap-sm">{trailing}</div>
      ) : null}
    </div>
  );
}

/**
 * A person's action on the run: shown as working until the server answers,
 * one at a time, with the server's refusal kept beside the control that sent it.
 */
export function useAwaitedAction<Key extends string>() {
  const [pending, setPending] = useState<Key | null>(null);
  const [refusal, setRefusal] = useState<{
    key: Key;
    message: string;
  } | null>(null);
  // A second click in the same tick happens before `pending` renders.
  const inFlight = useRef(false);
  const act = async (
    key: Key,
    action: () => void | Promise<void>,
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(key);
    setRefusal(null);
    try {
      await action();
    } catch (error) {
      setRefusal({
        key,
        message:
          error instanceof Error
            ? error.message
            : "The run did not take that. Refresh the run and try again.",
      });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return { pending, refusal, act };
}

/** Why the run refused what the person asked. */
export function Refusal({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="m-0 rounded-md border border-solid border-[var(--cc-red-a40)] bg-red-glow px-md py-sm font-mono text-[0.72rem] leading-[1.5] text-red-text"
    >
      {message}
    </p>
  );
}

/**
 * What a run or context cost. Once a seat's conversation is gone its spending
 * is unknown, so the total is what is still known, and says so.
 */
export function Cost({
  usd,
  complete,
}: {
  usd: number | null;
  complete: boolean;
}) {
  if (complete || usd === null) return <>{formatUsd(usd)}</>;
  return (
    <span
      aria-label={`at least ${formatUsd(usd)}`}
      title="A seat's conversation is gone, so what it spent is not counted"
    >
      {formatUsd(usd)}+
    </span>
  );
}
