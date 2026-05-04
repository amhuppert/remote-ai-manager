import { notFound } from "next/navigation";
import MachineDetail from "./MachineDetail";
import { getMachineSpec, machineSpecs } from "../machine-specs";
import { isMachineId } from "../machine-spec-types";

interface PageProps {
  params: Promise<{ machine: string }>;
}

export default async function MachinePage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { machine } = await params;
  if (!isMachineId(machine)) {
    notFound();
  }
  const siblings = machineSpecs.map((s) => ({ id: s.id, name: s.name }));
  return <MachineDetail spec={getMachineSpec(machine)} siblings={siblings} />;
}
