import TicketDetailView from "./components/TicketDetailView";
import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";
import { parseTicketNumberSegment } from "@/lib/tickets/ticket-number";
import { notFound } from "next/navigation";

interface TicketDetailPageProps {
  params: Promise<{ projectName: string; number: string }>;
}

export default async function TicketDetailPage({
  params,
}: TicketDetailPageProps): Promise<React.JSX.Element> {
  const { projectName, number } = await params;
  const ticketNumber = parseTicketNumberSegment(number);
  if (ticketNumber === null) notFound();
  return (
    <TicketDetailView
      projectName={decodeRouteSegment(projectName)}
      number={ticketNumber}
    />
  );
}
