import type {
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
} from "react";
import { cn } from "@/lib/ui/cn";

// Parity-extracted from the `.form-*` recipes (globals.css). Each part owns its
// appearance and exposes only the layout-only `layoutClassName` slot.

const formGroupBase = "mb-lg";

export type FormGroupProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function FormGroup({ layoutClassName, ...rest }: FormGroupProps) {
  return <div {...rest} className={cn(formGroupBase, layoutClassName)} />;
}

const formLabelBase =
  "block font-mono text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-secondary mb-sm";

export type FormLabelProps = Omit<
  LabelHTMLAttributes<HTMLLabelElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function FormLabel({ layoutClassName, ...rest }: FormLabelProps) {
  return <label {...rest} className={cn(formLabelBase, layoutClassName)} />;
}

// `.form-input` is defined twice in globals.css (lines 989 and 7991); both are
// unscoped, so the later (7991) wins for every overlapping property while the
// first contributes its `::placeholder` colour. This is the merged effective
// recipe: padding 9px 12px, 0.82rem, hover border-strong, focus cyan + glow ring.
const formInputBase =
  "w-full px-[12px] py-[9px] bg-bg-base border border-solid border-border-default rounded-md text-text-primary font-mono text-[0.82rem] outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]";

export type FormInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function FormInput({ layoutClassName, ...rest }: FormInputProps) {
  return <input {...rest} className={cn(formInputBase, layoutClassName)} />;
}

const formHintBase = "font-mono text-[0.7rem] text-text-tertiary mt-xs";

export type FormHintProps = Omit<
  HTMLAttributes<HTMLParagraphElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function FormHint({ layoutClassName, ...rest }: FormHintProps) {
  return <p {...rest} className={cn(formHintBase, layoutClassName)} />;
}

const formErrorBase = "font-mono text-[0.72rem] text-red mt-xs";

export type FormErrorProps = Omit<
  HTMLAttributes<HTMLParagraphElement>,
  "className" | "style"
> & {
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
};

export function FormError({ layoutClassName, ...rest }: FormErrorProps) {
  return <p {...rest} className={cn(formErrorBase, layoutClassName)} />;
}
