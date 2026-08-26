import { Fragment } from "react";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

export interface ModelSelectionMetadataProps {
  selection: BackendModelSelection;
}

export default function ModelSelectionMetadata({
  selection,
}: ModelSelectionMetadataProps): React.JSX.Element {
  const parameters = Object.entries(selection.parameters).sort(
    ([left], [right]) => left.localeCompare(right),
  );

  return (
    <>
      <span className="text-text-secondary">{selection.modelId}</span>
      {parameters.map(([parameterId, value]) => (
        <Fragment key={parameterId}>
          <span className="mx-[5px] text-text-tertiary">&middot;</span>
          <span className="text-text-secondary">
            {parameterId}={value}
          </span>
        </Fragment>
      ))}
    </>
  );
}
