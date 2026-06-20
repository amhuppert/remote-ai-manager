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
    <section className="max-w-[880px]">
      <header className="mb-xl">
        <h1 className="m-0 font-display text-[2rem] leading-[1.05] font-extrabold tracking-normal text-text-primary">
          {title}{" "}
          <span className="text-cyan [text-shadow:0_0_18px_var(--cyan-glow-text)]">
            {accent}
          </span>
        </h1>
        <p className="mt-[6px] font-mono text-[0.78rem] text-text-secondary">
          {sub}
        </p>
      </header>
      <div className="flex flex-col gap-md">{children}</div>
    </section>
  );
}
