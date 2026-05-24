/**
 * SSE subscription handler for /api/events.
 *
 * Streams live workflow/notification/session events to connected clients.
 * Honours the `Last-Event-ID` request header to replay missed frames after
 * a reconnect.
 */

import {
  addClient,
  removeClient,
  replayFramesSince,
} from "@/lib/events/broadcaster";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15_000;

export function subscribeToEvents(request: Request): Response {
  let savedController: ReadableStreamDefaultController;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const lastEventIdHeader = request.headers.get("Last-Event-ID");
  let lastEventId: number | null = null;
  if (lastEventIdHeader !== null) {
    const parsed = Number.parseInt(lastEventIdHeader, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      lastEventId = parsed;
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      savedController = controller;
      addClient(controller);

      if (lastEventId !== null) {
        const frames = replayFramesSince(lastEventId);
        for (const frame of frames) {
          controller.enqueue(frame);
        }
      }

      controller.enqueue(encoder.encode(`event: connected\ndata: {}\n\n`));

      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          if (heartbeatTimer !== undefined) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      removeClient(savedController);
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
