import type { ReactNode } from "react";

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
  const cls = [
    "config-field",
    isModified ? "modified" : "",
    readOnly ? "config-field-readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} data-field={fieldPath}>
      <div className="config-field-header">
        <span className="config-field-label">{label}</span>
        {readOnly && <span className="config-field-lock">LOCKED</span>}
        {isDefault && <span className="config-badge-default">DEFAULT</span>}
      </div>
      {children}
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  );
}
