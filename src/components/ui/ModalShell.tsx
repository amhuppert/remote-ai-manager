import type { HTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

export type ModalSize = "default" | "confirm";

// Overlay z-index 200 maps to the `dropdown` tier (theme.css z-index matrix).
// `fadeIn` is held at the legacy modal duration (0.15s) via an arbitrary
// animation rather than the canonical `--animate-fade-in` token (0.3s), which
// would visibly slow the overlay entry — parity wins over canonicalisation here.
const overlayBase =
  "fixed inset-0 z-dropdown flex items-center justify-center bg-[var(--cc-overlay-scrim)] backdrop-blur-[8px] animate-[fadeIn_0.15s_ease]";

// `slideUp` is a bespoke (non-tokenised) keyframe; referenced at its legacy 0.2s.
const cardBase =
  "w-full bg-bg-surface border border-solid border-border-default rounded-lg p-xl animate-[slideUp_0.2s_ease]";

const cardSize: Record<ModalSize, string> = {
  default: "max-w-[480px]",
  confirm: "max-w-[400px]",
};

export type ModalShellProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  size?: ModalSize;
  /** Attributes for the fixed full-screen overlay (e.g. onClick to dismiss). */
  overlayProps?: Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">;
  /** External-geometry utilities for the modal card; appended after appearance. */
  layoutClassName?: string;
};

export function ModalShell({
  size = "default",
  overlayProps,
  layoutClassName,
  ...rest
}: ModalShellProps) {
  return (
    <div {...overlayProps} className={overlayBase}>
      <div
        {...rest}
        className={cn(cardBase, cardSize[size], layoutClassName)}
      />
    </div>
  );
}

const modalTitleBase = "font-display font-bold text-[1.2rem] mb-lg";

export type ModalTitleProps = Omit<
  HTMLAttributes<HTMLHeadingElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function ModalTitle({ layoutClassName, ...rest }: ModalTitleProps) {
  return <h2 {...rest} className={cn(modalTitleBase, layoutClassName)} />;
}

const modalActionsBase = "flex justify-end gap-sm";

export type ModalActionsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function ModalActions({ layoutClassName, ...rest }: ModalActionsProps) {
  return <div {...rest} className={cn(modalActionsBase, layoutClassName)} />;
}
