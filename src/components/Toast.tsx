"use client";

import type { ToastAction } from "@/stores/toast.store";

interface ToastProps {
  message: string;
  action?: ToastAction;
  onDismiss: () => void;
}

export default function Toast({
  message,
  action,
  onDismiss,
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
      className="fixed bottom-[24px] left-1/2 z-dropdown [transform:translateX(-50%)] rounded-full border border-solid border-cyan-dim bg-[rgba(20,25,35,0.96)] px-[18px] py-[10px] font-mono text-[0.74rem] text-text-primary shadow-[0_8px_24px_var(--cc-black-a50),0_0_18px_var(--color-cyan-glow)] animate-bulk-float-in"
      onClick={onDismiss}
      aria-live="polite"
    >
      {message}
      {action && (
        <button
          type="button"
          className="ml-[12px] inline-flex cursor-pointer items-center rounded-full border border-solid border-cyan-dim bg-transparent px-[10px] py-[2px] font-mono text-[0.72rem] font-semibold text-cyan"
          onClick={(event) => {
            event.stopPropagation();
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
