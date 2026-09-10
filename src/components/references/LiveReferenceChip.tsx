"use client";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { onlineManager } from "@tanstack/react-query";
import type { LiveReferenceTarget } from "@/lib/live-references/schemas";
import { useLiveReference } from "@/lib/live-references/queries";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/Popover";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("live-reference-chip");
const subscribeOnline = (callback: () => void) =>
  onlineManager.subscribe(callback);

export interface LiveReferenceChipProps {
  target: LiveReferenceTarget;
  title: string;
  identity: string;
  reference: string;
  glyph?: ReactNode;
  selected?: boolean;
  onRemove?(): void;
}

export function createLiveReferenceChip(deps: {
  useReference(
    target: LiveReferenceTarget,
    enabled: boolean,
  ): Pick<ReturnType<typeof useLiveReference>, "data" | "isError">;
}) {
  return function LiveReferenceChip(
    props: LiveReferenceChipProps,
  ): React.JSX.Element {
    const host = useRef<HTMLSpanElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const openAction = useRef<HTMLAnchorElement>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
    const pinned = useRef(false);
    const restoringFocus = useRef(false);
    const restoreOnClose = useRef(false);
    const [visible, setVisible] = useState(true);
    const [open, setOpen] = useState(false);
    const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
      "idle",
    );
    const online = useSyncExternalStore(
      subscribeOnline,
      () => onlineManager.isOnline(),
      () => true,
    );
    const query = deps.useReference(props.target, visible);
    const summary = query.data?.summary;
    const stale = !online || query.isError;
    const missing = query.data?.unavailableReason === "missing";
    const title = summary?.title || props.title || props.identity;
    const identity = summary?.identity ?? props.identity;
    const status = missing
      ? "Unavailable"
      : (summary?.status ?? (stale ? "Unavailable" : "Loading"));
    const tone = missing ? "red" : (summary?.tone ?? "neutral");

    useEffect(() => {
      if (!host.current || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver((entries) =>
        setVisible(entries.some((entry) => entry.isIntersecting)),
      );
      observer.observe(host.current);
      return () => observer.disconnect();
    }, []);
    useEffect(() => () => clearTimeout(closeTimer.current), []);

    const preview = () => {
      clearTimeout(closeTimer.current);
      if (!restoringFocus.current) setOpen(true);
    };
    const leave = () => {
      clearTimeout(closeTimer.current);
      if (!pinned.current)
        closeTimer.current = setTimeout(() => setOpen(false), 180);
    };
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(props.reference);
        setCopyState("copied");
        logger.debug("live_reference.copied", {
          kind: props.target.kind,
          id: props.target.id,
        });
      } catch {
        setCopyState("failed");
        logger.warn("live_reference.copy_failed", {
          kind: props.target.kind,
          id: props.target.id,
        });
      }
    };

    return (
      <span
        ref={host}
        contentEditable={false}
        data-live-reference={props.target.kind}
        data-selected={props.selected || undefined}
        className="inline-flex max-w-full items-center gap-2xs rounded-md border border-solid border-border-default bg-bg-raised align-baseline font-mono text-[0.78rem] leading-normal data-[selected=true]:border-cyan"
      >
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (next) pinned.current = true;
            setOpen(next);
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type="button"
              aria-label={`${title} · ${status}${stale && summary ? " · Stale" : ""}`}
              className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-sm rounded-md border-0 bg-transparent px-sm py-2xs font-mono text-text-primary hover:bg-bg-elevated focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[36px]"
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") preview();
              }}
              onPointerLeave={leave}
              onFocus={preview}
              onBlur={() => {
                if (!pinned.current) leave();
              }}
              onClick={(event) => {
                event.preventDefault();
                pinned.current = true;
                setOpen(true);
                clearTimeout(closeTimer.current);
                requestAnimationFrame(() => openAction.current?.focus());
              }}
            >
              {props.glyph ?? <ReferenceGlyph kind={props.target.kind} />}
              {props.target.kind === "ticket" && (
                <span className="max-w-[min(40vw,160px)] shrink-0 truncate text-text-primary/75">
                  {identity}
                </span>
              )}
              <span className="min-w-0 truncate">{title}</span>
              <StatusChip tone={tone} appearance="flat">
                {tone === "neutral" || tone === "red" ? (
                  <span
                    className={
                      tone === "red"
                        ? "text-text-primary"
                        : "text-text-primary/75"
                    }
                  >
                    {status}
                  </span>
                ) : (
                  status
                )}
              </StatusChip>
              {!!summary?.attentionCount && (
                <span
                  className="shrink-0 text-amber"
                  aria-label={`${summary.attentionCount} pending decisions`}
                >
                  Awaiting you
                </span>
              )}
              {stale && summary && (
                <span className="shrink-0 text-amber">Stale</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            layoutClassName="w-[340px] max-w-[calc(100vw-24px)]"
            aria-label={`${title} reference preview`}
            onPointerEnter={() => clearTimeout(closeTimer.current)}
            onPointerLeave={leave}
            onFocusCapture={() => {
              pinned.current = true;
              clearTimeout(closeTimer.current);
            }}
            onEscapeKeyDown={() => {
              restoreOnClose.current = true;
            }}
            onInteractOutside={() => {
              restoreOnClose.current = false;
            }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (restoreOnClose.current) {
                restoringFocus.current = true;
                trigger.current?.focus();
                restoringFocus.current = false;
              }
              pinned.current = false;
              restoreOnClose.current = false;
            }}
          >
            <div className="flex flex-col gap-md font-mono text-[0.78rem] leading-relaxed">
              <div className="flex items-center justify-between gap-sm">
                <span className="text-[0.7rem] tracking-wider text-text-primary/75 uppercase">
                  {props.target.kind === "execution"
                    ? "Workflow execution"
                    : props.target.kind}
                </span>
                <StatusChip tone={tone}>
                  {tone === "neutral" || tone === "red" ? (
                    <span
                      className={
                        tone === "red"
                          ? "text-text-primary"
                          : "text-text-primary/75"
                      }
                    >
                      {status}
                    </span>
                  ) : (
                    status
                  )}
                </StatusChip>
              </div>
              <div>
                <div className="font-semibold [overflow-wrap:anywhere] text-text-primary">
                  {title}
                </div>
                <div className="mt-2xs text-[0.7rem] [overflow-wrap:anywhere] text-text-primary/75">
                  {identity}
                </div>
              </div>
              {summary && (
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-md gap-y-xs">
                  {summary.details.map((detail, index) => (
                    <Detail key={`${detail.label}-${index}`} {...detail} />
                  ))}
                </dl>
              )}
              <div
                className={cn(
                  "text-[0.7rem]",
                  stale || missing ? "text-amber" : "text-text-primary/75",
                )}
              >
                {missing
                  ? "This reference is no longer available."
                  : stale
                    ? summary
                      ? "Live updates unavailable. Showing the last known information."
                      : "Live updates unavailable. Try again when connected."
                    : query.data
                      ? `Checked ${new Date(query.data.checkedAt).toLocaleTimeString()}`
                      : "Loading current state…"}
              </div>
              <div className="flex flex-wrap items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-subtle pt-md">
                {summary && !missing && (
                  <a
                    ref={openAction}
                    href={summary.href}
                    className="inline-flex items-center gap-xs rounded-sm border border-solid border-border-default bg-bg-raised px-md py-xs text-text-primary no-underline hover:bg-bg-elevated focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[36px]"
                  >
                    Open{" "}
                    <svg
                      aria-hidden="true"
                      width="12"
                      height="12"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                    >
                      <path d="M4 2h6v6M10 2 2 10" />
                    </svg>
                  </a>
                )}
                <Button size="sm" touch onClick={() => void copy()}>
                  {copyState === "copied" ? "Copied" : "Copy reference"}
                </Button>
                {copyState === "failed" && (
                  <span role="status" className="text-red">
                    Copy failed. Try again.
                  </span>
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        {props.onRemove && (
          <WithTooltip label="Remove reference">
            <button
              type="button"
              aria-label={`Remove ${props.target.kind} reference ${title}`}
              className="mr-2xs shrink-0 cursor-pointer rounded-sm border-0 bg-transparent px-xs py-2xs text-text-primary hover:bg-red-glow hover:text-red focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[36px]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onRemove?.();
              }}
            >
              <svg
                aria-hidden="true"
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m3 3 6 6M9 3 3 9" />
              </svg>
            </button>
          </WithTooltip>
        )}
      </span>
    );
  };
}

export const LiveReferenceChip = createLiveReferenceChip({
  useReference: useLiveReference,
});

function Detail({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-text-primary/75">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-text-primary">
        {value}
      </dd>
    </>
  );
}

export function ReferenceGlyph({
  kind,
}: {
  kind: LiveReferenceTarget["kind"];
}): React.JSX.Element {
  const paths = {
    ticket: "M3 6h14v3a3 3 0 0 0 0 6v3H3v-3a3 3 0 0 0 0-6V6Z",
    conversation: "M3 3h14v11H8l-5 4V3Z",
    execution: "M3 4h5v5H3zM12 12h5v5h-5zM8 6h6v6",
  };
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="shrink-0 text-text-primary/75"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
