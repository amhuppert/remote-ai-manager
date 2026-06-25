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

export type BulkConfirmKind = "archive" | "unarchive" | "delete";

interface BulkConfirmModalProps {
  open: boolean;
  kind: BulkConfirmKind;
  count: number;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

interface Copy {
  title: string;
  body: string;
  primary: string;
  danger: boolean;
}

function buildCopy(kind: BulkConfirmKind, count: number): Copy {
  const noun = count === 1 ? "session" : "sessions";
  if (kind === "archive") {
    return {
      title: "Archive sessions?",
      body: `Archive ${count} ${noun}. They stay accessible via "Include archived".`,
      primary: `Archive ${count}`,
      danger: false,
    };
  }
  if (kind === "unarchive") {
    return {
      title: "Unarchive sessions?",
      body: `Unarchive ${count} ${noun}.`,
      primary: `Unarchive ${count}`,
      danger: false,
    };
  }
  return {
    title: "Delete sessions?",
    body: `This permanently removes the worktree, history, and state for ${count} ${noun}. The git branch is preserved. This cannot be undone.`,
    primary: `Delete ${count}`,
    danger: true,
  };
}

/**
 * Controlled bulk archive/unarchive/delete confirm over the Radix-backed
 * `AlertDialog` primitive. Radix owns role=alertdialog, focus trap + return,
 * Escape dismissal, the inert background, and `useOverlayScope` registration —
 * replacing the previous hand-rolled capture-phase Escape listener. The confirm
 * Action and the Cancel/Escape paths both close via `onOpenChange(false)`, so a
 * ref flag keeps `onConfirm` and `onClose` single-fire. While `isPending` the
 * parent keeps `open` true, so Radix's close request after confirm is declined
 * and the dialog stays visible showing the disabled, in-flight state.
 */
export default function BulkConfirmModal({
  open,
  kind,
  count,
  isPending,
  onConfirm,
  onClose,
}: BulkConfirmModalProps): React.JSX.Element {
  const confirmedRef = useRef(false);
  const copy = buildCopy(kind, count);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (confirmedRef.current) {
          confirmedRef.current = false;
          onConfirm();
        } else {
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{copy.title}</AlertDialogTitle>
        <AlertDialogDescription>{copy.body}</AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            danger={copy.danger}
            disabled={isPending}
            onClick={() => {
              confirmedRef.current = true;
            }}
          >
            {copy.primary}
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}
