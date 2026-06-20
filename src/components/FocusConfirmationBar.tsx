"use client";

import { Button } from "@/components/ui/Button";

interface FocusConfirmationBarProps {
  onConfirm: () => void;
  disabled?: boolean;
  loading?: boolean;
}

// The legacy `.focus-confirm-bar .btn { white-space: nowrap }` descendant rule is
// re-homed onto the container as `[&>button]:whitespace-nowrap` — the `Button`
// primitive does not bake `white-space: nowrap`, so the bar applies it to its
// direct button child.
export default function FocusConfirmationBar({
  onConfirm,
  disabled = false,
  loading = false,
}: FocusConfirmationBarProps) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-surface px-lg py-sm [&>button]:whitespace-nowrap">
      <div className="font-mono text-[0.72rem] text-text-secondary">
        {loading
          ? "Writing focus document..."
          : "Satisfied with the understanding?"}
      </div>
      <Button
        variant="primary"
        size="sm"
        touch
        onClick={onConfirm}
        disabled={disabled || loading}
      >
        {loading ? (
          <div
            className="spinner"
            style={{
              borderColor: "rgba(0, 229, 255, 0.3)",
              borderTopColor: "var(--text-inverse)",
              width: 14,
              height: 14,
            }}
          />
        ) : (
          "Confirm & Continue"
        )}
      </Button>
    </div>
  );
}
