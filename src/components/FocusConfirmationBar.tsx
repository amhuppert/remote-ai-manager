"use client";

interface FocusConfirmationBarProps {
  onConfirm: () => void;
  disabled?: boolean;
  loading?: boolean;
}

export default function FocusConfirmationBar({
  onConfirm,
  disabled = false,
  loading = false,
}: FocusConfirmationBarProps) {
  return (
    <div className="focus-confirm-bar">
      <div className="focus-confirm-text">
        {loading
          ? "Writing focus document..."
          : "Satisfied with the understanding?"}
      </div>
      <button
        className="btn btn-sm btn-primary"
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
      </button>
    </div>
  );
}
