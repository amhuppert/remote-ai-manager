"use client";

import type { ToastAction } from "@/stores/toast.store";
import { CloseIcon } from "@/components/icons";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { cn } from "@/lib/ui/cn";

type ToastPlacement = "standalone" | "stacked";

const placementClass: Record<ToastPlacement, string> = {
  standalone:
    "fixed bottom-[24px] left-1/2 z-dropdown [transform:translateX(-50%)] animate-bulk-float-in",
  stacked:
    "pointer-events-auto max-w-full shrink-0 motion-safe:animate-fade-in",
};

interface ToastProps {
  message: string;
  action?: ToastAction;
  onDismiss: () => void;
  placement?: ToastPlacement;
}

export default function Toast({
  message,
  action,
  onDismiss,
  placement = "standalone",
}: ToastProps): React.JSX.Element {
  // Reproduces the legacy `.cc-toast` recipe (globals.css) inline. The
  // `bulk-float-in` @keyframes stays in CSS (preserved); `animate-bulk-float-in`
  // resolves it via the --animate-bulk-float-in theme token. The translucent
  // surface `rgba(20,25,35,0.96)` has no design token yet — integration must mint
  // a --cc-* token for it before adding this file to the no-hardcoded-color
  // allowlist.
  //
  // Centering uses the arbitrary `[transform:translateX(-50%)]` (not the
  // `-translate-x-1/2` utility) on purpose: the `bulk-float-in` keyframes animate
  // the `transform` property (`translate(-50%, …)`). The Tailwind utility emits
  // the separate `translate` property, which COMPOSES with the keyframe's
  // `transform` and double-offsets X by -50% during the float-in. Writing the
  // legacy `transform` property directly lets the keyframe override it cleanly,
  // byte-identical to `.cc-toast`.
  return (
    <div
      role="status"
      className={cn(
        "rounded-full border border-solid border-cyan-dim bg-[rgba(20,25,35,0.96)] px-[18px] py-[10px] font-mono text-[0.74rem] text-text-primary shadow-[0_8px_24px_var(--cc-black-a50),0_0_18px_var(--color-cyan-glow)]",
        placementClass[placement],
      )}
      aria-live="polite"
    >
      {message}
      {action && (
        <button
          type="button"
          className="ml-[12px] inline-flex min-h-[24px] min-w-[24px] cursor-pointer items-center justify-center rounded-full border border-solid border-cyan-dim bg-transparent px-[10px] py-[2px] font-mono text-[0.72rem] font-semibold text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
        </button>
      )}
      <WithTooltip label="Dismiss notification">
        <button
          type="button"
          className="ml-sm inline-flex size-[24px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          <CloseIcon size={12} />
        </button>
      </WithTooltip>
    </div>
  );
}
