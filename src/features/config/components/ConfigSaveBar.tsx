import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";

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
  const dirty = dirtyCount > 0;
  return (
    <div className="flex items-center justify-end gap-md flex-none py-[12px] px-2xl border-x-0 border-b-0 border-t border-solid border-border-default bg-bg-void sticky bottom-0 z-sticky mt-xl rounded-md [backdrop-filter:blur(16px)_saturate(140%)] max-768:fixed max-768:bottom-0 max-768:left-0 max-768:right-0 max-768:p-md max-768:rounded-none">
      <div className="flex items-center gap-[6px] mr-auto text-text-secondary font-mono text-[0.76rem] whitespace-nowrap">
        <span
          className={cn(
            "w-[7px] h-[7px] rounded-full",
            dirty
              ? "bg-amber shadow-[0_0_8px_var(--amber-glow)]"
              : "bg-text-tertiary",
          )}
        />
        {dirty ? (
          <>
            <span className="text-amber font-semibold">{dirtyCount}</span>{" "}
            unsaved {dirtyCount === 1 ? "change" : "changes"}
          </>
        ) : (
          "All changes saved"
        )}
      </div>
      <div className="flex gap-sm ml-auto">
        <Button
          variant="ghost"
          size="sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onRevert}
          type="button"
        >
          Revert
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onSave}
          type="button"
        >
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
