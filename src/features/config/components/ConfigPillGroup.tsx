import { cn } from "@/lib/ui/cn";

const PILL_BASE =
  "block px-[14px] py-[6px] rounded-sm font-mono text-[0.74rem] cursor-pointer transition-all duration-150 ease-[ease]";

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
    <div className="inline-flex flex-wrap w-fit max-w-full gap-[2px] p-[3px] rounded-md border border-solid border-border-subtle bg-bg-base">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={cn(
            PILL_BASE,
            value === opt
              ? "bg-cyan text-text-inverse font-semibold border border-solid border-cyan"
              : "bg-transparent text-text-secondary font-medium hover:bg-bg-hover hover:text-text-primary",
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
