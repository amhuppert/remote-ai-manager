export function ConfigSaveBar({
  dirtyCount,
  saving,
  onRevert,
  onSave,
}: {
  dirtyCount: number;
  saving: boolean;
  onRevert(): void;
  onSave(): void;
}): React.JSX.Element {
  return (
    <div className="config-save-bar">
      <div
        className={
          dirtyCount > 0
            ? "config-save-bar-status"
            : "config-save-bar-status config-save-bar-status--clean"
        }
      >
        <span className="config-save-bar-dot" />
        {dirtyCount > 0 ? (
          <>
            <span className="config-save-bar-count">{dirtyCount}</span> unsaved{" "}
            {dirtyCount === 1 ? "change" : "changes"}
          </>
        ) : (
          "All changes saved"
        )}
      </div>
      <div className="config-save-bar-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onRevert}
          type="button"
        >
          Revert
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onSave}
          type="button"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}
