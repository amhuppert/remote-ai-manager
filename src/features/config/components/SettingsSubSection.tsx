import type { ReactNode } from "react";

export function SettingsSubSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg max-768:rounded-none max-768:border-x-0">
      <div className="flex cursor-default items-center gap-[7px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base px-[14px] py-[11px] text-left font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase select-text">
        {title}
      </div>
      {hint ? (
        <div className="px-[14px] pt-[8px] pb-0 font-mono text-[0.7rem] text-text-tertiary">
          {hint}
        </div>
      ) : null}
      <div className="mt-md flex flex-col gap-md px-[14px] pt-md pb-[14px]">
        {children}
      </div>
    </section>
  );
}
