import type { ReactNode } from "react";

export function SettingsPage({
  title,
  accent,
  sub,
  children,
}: {
  title: string;
  accent: string;
  sub: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="config-settings-page">
      <header className="config-settings-page__head">
        <h1 className="config-settings-page__title">
          {title} <span>{accent}</span>
        </h1>
        <p className="config-settings-page__subtitle">{sub}</p>
      </header>
      <div className="config-settings-page__body">{children}</div>
    </section>
  );
}
