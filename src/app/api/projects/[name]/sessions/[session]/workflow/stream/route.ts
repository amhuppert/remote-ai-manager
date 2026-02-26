import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { addClient } from "@/lib/ralph-loop/workflow-stream-registry";

export const dynamic = "force-dynamic";

/** GET — Stream live iteration content via ReadableStream (NDJSON) */
export async function GET(
  _request: Request,
  { params }: { params: Promise<Record<string, string>> },
): Promise<Response> {
  const resolvedParams = await params;
  const name = resolvedParams["name"] ?? "";
  const sessionSlug = resolvedParams["session"] ?? "";
  const sessionName = decodeURIComponent(sessionSlug);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    return new Response(JSON.stringify({ error: "Project not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session = await getSession(projectPath, sessionName);
  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Create a ReadableStream and register the controller
  const stream = new ReadableStream({
    start(controller) {
      const cleanup = addClient(projectPath, sessionName, controller);

      // Clean up on abort (client disconnect)
      _request.signal.addEventListener("abort", () => {
        cleanup();
      });
    },
    cancel() {
      // Stream cancelled by the client
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
    },
  });
}
