import type { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import { FormHint } from "@/components/ui/FormField";

const FIELD_BASE =
  "relative flex flex-col gap-[5px] min-w-0 mb-lg last:mb-0 " +
  "border-y-0 border-r-0 border-l-2 border-solid " +
  "transition-[border-color,padding-left] duration-150 ease-[ease]";
const FIELD_LABEL =
  "font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase text-text-secondary whitespace-nowrap";
const FIELD_BADGE_BASE =
  "ml-auto px-[7px] py-[2px] rounded-full border border-solid border-border-subtle text-text-tertiary font-mono text-[0.7rem] font-semibold tracking-[0.08em] uppercase";

export function ConfigField({
  label,
  fieldPath,
  isDefault,
  isModified,
  readOnly,
  hint,
  children,
}: {
  label: string;
  fieldPath: string;
  isDefault: boolean;
  isModified: boolean;
  readOnly?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        FIELD_BASE,
        isModified ? "border-l-cyan pl-md" : "border-l-transparent",
        readOnly && "opacity-60",
      )}
      data-field={fieldPath}
    >
      <div className="mb-sm flex min-h-[18px] items-center gap-sm">
        <span className={FIELD_LABEL}>{label}</span>
        {readOnly && <span className={FIELD_BADGE_BASE}>LOCKED</span>}
        {isDefault && (
          <span
            className={cn(
              FIELD_BADGE_BASE,
              "inline-flex items-center bg-bg-raised",
            )}
          >
            DEFAULT
          </span>
        )}
      </div>
      {children}
      {hint && <FormHint>{hint}</FormHint>}
    </div>
  );
}
