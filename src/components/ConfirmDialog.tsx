"use client";

import { useRef } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogActions,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/AlertDialog";
import { useOpenerFocus } from "@/hooks/use-opener-focus";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Hide the cancel button to render an acknowledge-only (info) dialog. */
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Controlled confirm / acknowledge prompt over the Radix-backed `AlertDialog`
 * primitive (WAI-ARIA Alert Dialog). Radix owns role=alertdialog, the focus
 * trap + return, Escape dismissal, the inert background, and `useOverlayScope`
 * registration — replacing the previous hand-rolled capture-phase keydown
 * listener. Per migration-contract §2 this drops the legacy Enter→confirm
 * shortcut and the autofocus-on-confirm: Radix lands focus on the safe Cancel
 * action, and an alert dialog ignores outside-pointer dismissal.
 *
 * The dialog is fully controlled by the parent's `open` prop. Radix routes
 * every dismissal (Cancel, Escape) through `onOpenChange(false)`; the confirm
 * Action also closes, so a ref flag distinguishes a confirm from a cancel and
 * keeps each callback single-fire.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  hideCancel = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const confirmedRef = useRef(false);
  // ConfirmDialog is always state-opened (no Radix trigger), so Radix cannot
  // restore focus on close; capture the opener and return focus explicitly.
  const { captureOpener, restoreOpener } = useOpenerFocus();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (confirmedRef.current) {
          confirmedRef.current = false;
          onConfirm();
        } else {
          onCancel();
        }
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{message}</AlertDialogDescription>
        <AlertDialogActions>
          {!hideCancel && <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>}
          <AlertDialogAction
            danger={danger}
            onClick={() => {
              confirmedRef.current = true;
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}
