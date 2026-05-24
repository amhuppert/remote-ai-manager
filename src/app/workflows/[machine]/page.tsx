import { notFound } from "next/navigation";
import MachineDetail from "@/features/workflows-catalog/machine/MachineDetail";
import {
  getMachineSpec,
  machineSpecs,
} from "@/features/workflows-catalog/machine-specs";
import { isMachineId } from "@/features/workflows-catalog/machine-spec-types";

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
