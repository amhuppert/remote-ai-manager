import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";

export function ConfigSaveBar({
  dirtyCount,
  invalidCount,
  saving,
  onRevert,
  onSave,
}: {
  dirtyCount: number;
  invalidCount: number;
  saving: boolean;
  onRevert(): void;
  onSave(): void;
}): React.JSX.Element {
  const dirty = dirtyCount > 0;
  const invalid = invalidCount > 0;
  const hasLocalChanges = dirty || invalid;
  return (
    <div className="sticky bottom-0 z-sticky mt-xl flex flex-none items-center justify-end gap-md rounded-md border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-void px-2xl py-[12px] [backdrop-filter:blur(16px)_saturate(140%)] max-768:fixed max-768:right-0 max-768:bottom-0 max-768:left-0 max-768:flex-wrap max-768:rounded-none max-768:p-md max-768:pb-[calc(var(--spacing-md)+env(safe-area-inset-bottom,0px))]">
      <div
        className="mr-auto flex items-center gap-[6px] font-mono text-[0.76rem] whitespace-nowrap text-text-secondary max-768:basis-full"
        role="status"
        aria-live="polite"
      >
        <span
          className={cn(
            "h-[7px] w-[7px] rounded-full",
            hasLocalChanges
              ? "bg-amber shadow-[0_0_8px_var(--amber-glow)]"
              : "bg-text-tertiary",
          )}
        />
        {invalid ? (
          <span className="font-semibold text-red">
            {invalidCount} invalid {invalidCount === 1 ? "field" : "fields"}
          </span>
        ) : dirty ? (
          <>
            <span className="font-semibold text-amber">{dirtyCount}</span>{" "}
            unsaved {dirtyCount === 1 ? "change" : "changes"}
          </>
        ) : (
          "All changes saved"
        )}
      </div>
      <div className="ml-auto flex gap-sm">
        <Button
          variant="ghost"
          size="sm"
          touch
          disabled={!hasLocalChanges || saving}
          onClick={onRevert}
          type="button"
        >
          Revert
        </Button>
        <Button
          variant="primary"
          size="sm"
          touch
          disabled={!dirty || invalid || saving}
          onClick={onSave}
          type="button"
        >
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
