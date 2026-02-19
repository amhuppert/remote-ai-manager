import { addClient, removeClient } from "@/lib/sse-broadcaster";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export function GET(): Response {
  const stream = new ReadableStream({
    start(controller) {
      addClient(controller);
      controller.enqueue(
        encoder.encode(`event: connected\ndata: {}\n\n`),
      );
    },
    cancel(controller) {
      removeClient(controller as ReadableStreamDefaultController);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
