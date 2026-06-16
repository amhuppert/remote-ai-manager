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
    <section className="p-lg overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface max-768:rounded-none max-768:border-x-0">
      <div className="flex items-center gap-[7px] px-[14px] py-[11px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base text-text-secondary font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase text-left cursor-default select-text">
        {title}
      </div>
      {hint ? (
        <div className="pt-[8px] px-[14px] pb-0 text-text-tertiary font-mono text-[0.7rem]">
          {hint}
        </div>
      ) : null}
      <div className="flex flex-col gap-md mt-md px-[14px] pt-md pb-[14px]">
        {children}
      </div>
    </section>
  );
}
