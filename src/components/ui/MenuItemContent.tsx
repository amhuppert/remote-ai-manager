import type { ReactNode } from "react";

/** Shared icon gutter for dropdown and context-menu action rows. */
export function MenuItemIcon({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[20px] shrink-0 items-center justify-center self-start [&_svg]:size-[18px]"
    >
      {children}
    </span>
  );
}

/** Keeps descriptions aligned with their label, including wrapped rows. */
export function MenuItemText({
  children,
  description,
}: {
  children: ReactNode;
  description?: ReactNode;
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-2xs">
      <span>{children}</span>
      {description && (
        <span className="text-[0.7rem] leading-[1.5] font-normal text-text-secondary group-data-[highlighted]/menu-item:text-text-primary">
          {description}
        </span>
      )}
    </span>
  );
}
