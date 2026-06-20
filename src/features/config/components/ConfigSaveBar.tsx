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
    <div className="sticky bottom-0 z-sticky mt-xl flex flex-none items-center justify-end gap-md rounded-md border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-void px-2xl py-[12px] [backdrop-filter:blur(16px)_saturate(140%)] max-768:fixed max-768:right-0 max-768:bottom-0 max-768:left-0 max-768:rounded-none max-768:p-md">
      <div className="mr-auto flex items-center gap-[6px] font-mono text-[0.76rem] whitespace-nowrap text-text-secondary">
        <span
          className={cn(
            "h-[7px] w-[7px] rounded-full",
            dirty
              ? "bg-amber shadow-[0_0_8px_var(--amber-glow)]"
              : "bg-text-tertiary",
          )}
        />
        {dirty ? (
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
