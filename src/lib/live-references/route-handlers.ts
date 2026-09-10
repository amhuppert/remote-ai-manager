import { NextResponse } from "next/server";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import { createLogger, withTracing } from "@/lib/logging";
import { readBodyBounded } from "@/lib/shared/bounded-body";
import { liveReferenceRequestSchema } from "./schemas";
import { resolveLiveReferences } from "./service";
import { liveReferenceReader } from "./reader";

const auth = createAgentAuth();
const logger = createLogger("live-references.routes");

export const executionsGET = withTracing(
  async (request: Request): Promise<Response> => {
    if ((await auth.validateOptionalToken(request)).kind === "invalid")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { listExecutionReferences } =
      await import("@/lib/state-store/execution-reference-repo");
    const { getStateDb } = await import("@/lib/state-store");
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json(
      { items: listExecutionReferences(getStateDb(), query) },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);

export const referencesPOST = withTracing(
  async (request: Request): Promise<Response> => {
    const refused = await auth.validateOptionalToken(request);
    if (refused.kind === "invalid")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await readBodyBounded(request.body, 64 * 1024);
    if (!body.ok)
      return NextResponse.json(
        { error: "Reference request too large" },
        { status: 413 },
      );
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const parsed = liveReferenceRequestSchema.safeParse(value);
    if (!parsed.success)
      return NextResponse.json(
        { error: "Invalid references", issues: parsed.error.issues },
        { status: 400 },
      );
    const results = await resolveLiveReferences(
      parsed.data.targets,
      liveReferenceReader,
    );
    logger.debug("live_reference.batch_read", { count: results.length });
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
