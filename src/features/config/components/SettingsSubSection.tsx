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
    <section className="config-section">
      <div className="config-section-header">{title}</div>
      {hint ? <div className="config-section-hint">{hint}</div> : null}
      <div className="config-section-body">{children}</div>
    </section>
  );
}
