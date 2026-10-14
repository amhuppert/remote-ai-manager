import { findRefTags } from "@/lib/conversations/ref-tags";
import { conversationRefAttrsSchema } from "@/lib/conversations/schemas";
import { ticketRefAttrsSchema } from "@/lib/tickets/schemas";
import { liveReferenceKey, type LiveReferenceTarget } from "./schemas";

export function collectLiveReferenceTargets(
  text: string,
): LiveReferenceTarget[] {
  const source = text.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (code) =>
    " ".repeat(code.length),
  );
  const found: Array<{ start: number; target: LiveReferenceTarget }> = [];
  for (const ref of findRefTags(source, "ticket-ref")) {
    const parsed = ticketRefAttrsSchema.safeParse(ref.attrs);
    if (parsed.success)
      found.push({
        start: ref.start,
        target: {
          kind: "ticket",
          projectName: parsed.data["project-name"],
          id: String(Number(parsed.data["ticket-number"])),
        },
      });
  }
  for (const ref of findRefTags(source, "conversation-ref")) {
    const parsed = conversationRefAttrsSchema.safeParse(ref.attrs);
    if (parsed.success)
      found.push({
        start: ref.start,
        target: {
          kind: "conversation",
          projectName: parsed.data["project-name"],
          id: parsed.data["conversation-id"],
        },
      });
  }
  return [
    ...new Map(
      found
        .sort((a, b) => a.start - b.start)
        .map(({ target }) => [liveReferenceKey(target), target]),
    ).values(),
  ];
}
