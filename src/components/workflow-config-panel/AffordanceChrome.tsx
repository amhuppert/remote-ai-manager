"use client";

import { cn } from "@/lib/ui/cn";
import type {
  ConfigBannerDescriptor,
  ConfigSaveBarDescriptor,
} from "./affordance";
import { CONFIG_BUTTON_BOX } from "./ConfigControls";
import { AlertTriangleIcon, LockIcon, PauseIcon } from "./icons";

/**
 * The execution host's chrome: what the run's state permits, said once at the
 * top of the panel, and what an accepted edit costs, said once at the bottom.
 *
 * Both are presentational — the descriptors come from `./affordance`, so the
 * copy and the disabled rules are decided in one place and rendered here.
 */

const BANNER_TONE: Record<ConfigBannerDescriptor["tone"], string> = {
  neutral: "bg-bg-raised text-text-secondary",
  amber: "bg-amber-glow text-amber",
};

const NOTE_TONE: Record<ConfigSaveBarDescriptor["noteTone"], string> = {
  muted: "text-text-tertiary",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
};

function BannerIcon({
  icon,
}: {
  icon: ConfigBannerDescriptor["icon"];
}): React.JSX.Element {
  return (
    <span
      data-testid={`config-banner-icon-${icon}`}
      className="flex flex-shrink-0"
    >
      {icon === "lock" ? <LockIcon /> : <PauseIcon />}
    </span>
  );
}

export function ConfigAffordanceBanner({
  banner,
  onAction,
  pending = false,
  pendingLabel,
}: {
  banner: ConfigBannerDescriptor;
  onAction?: () => void;
  /** The action is in flight; it shows `pendingLabel` and stops accepting. */
  pending?: boolean;
  pendingLabel?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid="config-affordance-banner"
      className={cn(
        "flex flex-shrink-0 items-center gap-[10px] border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-[9px]",
        BANNER_TONE[banner.tone],
      )}
    >
      <BannerIcon icon={banner.icon} />
      <span className="min-w-0 flex-1 font-mono text-[0.72rem] leading-[1.45]">
        {banner.text}
      </span>
      {banner.actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          disabled={pending}
          className={cn(
            CONFIG_BUTTON_BOX,
            "h-[26px] flex-shrink-0 px-[10px] whitespace-nowrap",
          )}
        >
          {pending && pendingLabel ? pendingLabel : banner.actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A save that did not land, announced where the editing happens. It is a live
 * region rather than a banner: the reader's attention is in the body, and the
 * refusal arrives after they acted.
 */
export function ConfigSaveAlert({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid="config-save-alert"
      className="flex flex-shrink-0 items-start gap-[9px] border-x-0 border-t-0 border-b border-solid border-border-dim bg-red-glow px-lg py-[9px]"
    >
      <span className="mt-[1px] flex flex-shrink-0 text-red">
        <AlertTriangleIcon />
      </span>
      <span className="font-mono text-[0.72rem] leading-[1.45] text-red">
        {text}
      </span>
    </div>
  );
}

export function ConfigSaveBar({
  saveBar,
  onSave,
  onResume,
  resuming = false,
}: {
  saveBar: ConfigSaveBarDescriptor;
  onSave?: () => void;
  onResume?: () => void;
  /** The resume is in flight; the button says so and stops accepting. */
  resuming?: boolean;
}): React.JSX.Element {
  return (
    <div
      data-testid="config-save-bar"
      className="flex flex-shrink-0 items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim bg-bg-surface px-lg py-[9px]"
    >
      <button
        type="button"
        onClick={onSave}
        disabled={saveBar.saveDisabled}
        className={cn(
          CONFIG_BUTTON_BOX,
          "h-[28px] flex-shrink-0 border-cyan-glow-strong bg-cyan-glow px-[12px] whitespace-nowrap text-cyan hover:enabled:border-cyan hover:enabled:bg-cyan-glow hover:enabled:text-cyan",
        )}
      >
        {saveBar.saveLabel}
      </button>
      {saveBar.showResume ? (
        <button
          type="button"
          onClick={onResume}
          disabled={resuming}
          className={cn(
            CONFIG_BUTTON_BOX,
            "h-[28px] flex-shrink-0 px-[12px] whitespace-nowrap",
          )}
        >
          {resuming ? "Resuming…" : "Resume workflow"}
        </button>
      ) : null}
      <span
        data-testid="config-save-note"
        className={cn(
          "ml-auto font-mono text-[0.7rem]",
          NOTE_TONE[saveBar.noteTone],
        )}
      >
        {saveBar.note}
      </span>
    </div>
  );
}
