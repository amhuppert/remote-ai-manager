import { cn } from "@/lib/ui/cn";

// `appearance-none` plus an explicit transparent border neutralizes the UA button
// chrome (a `2px outset` bevel) so the flat, token-driven pills render correctly;
// the selected state only overrides the border color, keeping geometry stable.
const PILL_BASE =
  "block appearance-none border border-solid border-transparent px-[14px] py-[6px] rounded-sm font-mono text-[0.74rem] cursor-pointer transition-all duration-150 ease-[ease]";

export function ConfigPillGroup<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex w-fit max-w-full flex-wrap gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-base p-[3px]">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={cn(
            PILL_BASE,
            value === opt
              ? "border-cyan bg-cyan font-semibold text-text-inverse"
              : "bg-transparent font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary",
          )}
          onClick={() => !disabled && onChange(opt)}
          disabled={disabled}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
