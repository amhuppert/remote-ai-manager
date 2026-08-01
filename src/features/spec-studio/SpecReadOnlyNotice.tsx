export default function SpecReadOnlyNotice({
  reason,
  context,
}: {
  reason: string | null;
  context?: string;
}): React.JSX.Element {
  return (
    <section
      aria-label="Abandoned spec read-only notice"
      className="rounded-lg border border-solid border-red-dim bg-red-glow p-lg"
    >
      <h2 className="m-0 font-display text-[1.05rem] font-extrabold text-red">
        Abandoned spec — read-only
      </h2>
      <p className="mt-sm mb-0 text-[0.875rem] leading-relaxed text-text-primary">
        This spec is terminal. Its approved contract, questions, decisions,
        evidence, and history remain available for inspection, but no lifecycle
        or review action can change it.
      </p>
      {context ? (
        <p className="mt-sm mb-0 text-[0.8125rem] leading-relaxed text-text-secondary">
          {context}
        </p>
      ) : null}
      {reason ? (
        <p className="mt-md mb-0 border-l-2 border-solid border-red pl-md text-[0.8125rem] leading-relaxed text-text-secondary">
          Recorded reason: {reason}
        </p>
      ) : null}
    </section>
  );
}
