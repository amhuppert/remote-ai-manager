import type { HTMLAttributes } from "react";

export default function FieldGroupLabel(
  props: HTMLAttributes<HTMLSpanElement>,
): React.JSX.Element {
  return (
    <span
      {...props}
      className="mb-sm block font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase"
    />
  );
}
