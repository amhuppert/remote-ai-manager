import { notFound } from "next/navigation";
import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";
import { parseTicketNumberSegment } from "@/lib/tickets/ticket-number";
import TicketDependenciesView from "./components/TicketDependenciesView";

export default async function TicketDependenciesPage({
  params,
}: {
  params: Promise<{ projectName: string; number: string }>;
}): Promise<React.JSX.Element> {
  const { projectName, number } = await params;
  const ticketNumber = parseTicketNumberSegment(number);
  if (ticketNumber === null) notFound();
  return (
    <TicketDependenciesView
      projectName={decodeRouteSegment(projectName)}
      number={ticketNumber}
    />
  );
}
