import type { WorkflowDefinitionMutation } from "@/lib/workflow-graph/definition-schemas";

export default function WorkflowFinalizedLaunchMetadata({
  launch,
}: {
  launch: WorkflowDefinitionMutation;
}): React.JSX.Element {
  const { definition } = launch;

  return (
    <>
      <dl className="m-0 grid gap-xs font-mono text-[0.7rem] text-text-secondary">
        <div>
          <dt className="text-text-tertiary">origin</dt>
          <dd className="m-0 break-all text-text-primary">
            {definition.origin?.sourceUri}
          </dd>
        </div>
        <div>
          <dt className="text-text-tertiary">approval policy</dt>
          <dd className="m-0 text-text-primary">
            approvalRequired: {String(definition.approvalRequired)}
          </dd>
        </div>
      </dl>
      <ul className="mt-sm mb-0 list-none p-0 font-mono text-[0.68rem] text-text-secondary">
        {definition.charter.sourcesOfTruth.map((source) => (
          <li key={source.id}>{source.id}</li>
        ))}
      </ul>
      <ul className="mt-sm mb-0 list-none p-0 font-mono text-[0.68rem] text-text-secondary">
        {definition.lockedRegions?.map((lock) => (
          <li key={lock.paths.join("/")}>{lock.paths.join(", ")}</li>
        ))}
      </ul>
    </>
  );
}
