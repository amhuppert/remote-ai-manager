import WorkflowsIndex from "./WorkflowsIndex";
import { machineSpecs } from "./machine-specs";

export default function WorkflowsPage(): React.JSX.Element {
  return <WorkflowsIndex specs={machineSpecs} />;
}
