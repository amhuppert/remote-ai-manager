import { cn } from "@/lib/ui/cn";

export function ConfigToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center gap-sm ml-auto w-fit text-text-secondary font-mono text-[0.72rem] font-semibold tracking-[0.06em] uppercase"
      onClick={() => !disabled && onChange(!value)}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onChange(!value);
        }
      }}
    >
      <div
        className={cn(
          "relative w-[34px] h-[18px] rounded-full border border-solid cursor-pointer transition-all duration-150 ease-[ease]",
          value
            ? "border-cyan bg-cyan shadow-[0_0_12px_var(--cyan-glow)]"
            : "border-border-default bg-bg-base",
        )}
      >
        <div
          className={cn(
            "absolute top-px left-px w-[14px] h-[14px] rounded-full transition-[transform,background] duration-150 ease-[ease]",
            value ? "translate-x-[16px] bg-text-inverse" : "bg-text-tertiary",
          )}
        />
      </div>
      <span>{value ? "ON" : "OFF"}</span>
    </div>
  );
}
