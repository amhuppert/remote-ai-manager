import type { ReactNode } from "react";

export function ConfigSubsection({
  title,
  id,
  isDefault,
  children,
}: {
  title: string;
  id: string;
  isDefault: boolean;
  children: ReactNode;
}) {
  const cls = [
    "config-subsection",
    isDefault ? "config-subsection--default" : "config-subsection--modified",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} data-subsection={id}>
      <div className="config-subsection-header">
        <span>{title}</span>
        <span className="config-subsection-badge">
          {isDefault ? "DEFAULT" : "MODIFIED"}
        </span>
      </div>
      <div className="config-subsection-body">{children}</div>
    </div>
  );
}
