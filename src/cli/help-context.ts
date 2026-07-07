/**
 * Best-effort fetch of server-rendered dynamic help-context blocks
 * (docs/design/cc-cli/04 §4.4).
 *
 * The fail-open contract is the whole point: `--help` is the recovery path, so
 * ANY failure — no server/token (guarded before we call here), a connection
 * error, a timeout, a non-2xx status, or a body that does not match the
 * expected shape — yields `[]` with NO throw and NO output. Static help then
 * renders byte-identically. Help must never train an agent to fear `--help`.
 *
 * The response shape is mirrored locally (a tiny Zod object) rather than
 * imported from `@/lib/agent-help/schemas`: the CLI bundle must not pull in
 * server code, and the shape is trivially stable (doc 04 §4.2).
 */
import { z } from "zod";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import type { HelpContextBlock } from "./help-render";
import type { CliHost } from "./shared";

/** The 500 ms cap from doc 04 §4.4 — help is garnish, never worth a stall. */
const HELP_CONTEXT_TIMEOUT_MS = 500;

/** Local mirror of the server's `helpContextResponseSchema` (kept lenient for fail-open). */
const responseSchema = z.object({
  blocks: z.array(z.object({ title: z.string(), body: z.string() })),
});

export interface HelpContextParams {
  server: string;
  token: string;
  /** Space-joined command path, e.g. "workflow task complete". */
  command: string;
  project: string | null;
  session: string | null;
  conversation: string | null;
  executionId: string | null;
  contextId: string | null;
}

/**
 * Query `/api/agent/help-context` for the resolved command and return its
 * blocks, or `[]` on any failure. Never throws.
 */
export async function fetchHelpContext(
  host: CliHost,
  params: HelpContextParams,
): Promise<HelpContextBlock[]> {
  try {
    const url = new URL("/api/agent/help-context", params.server);
    url.searchParams.set("command", params.command);
    const optional: Array<[string, string | null]> = [
      ["project", params.project],
      ["session", params.session],
      ["conversation", params.conversation],
      ["executionId", params.executionId],
      ["contextId", params.contextId],
    ];
    for (const [key, value] of optional) {
      if (value !== null) url.searchParams.set(key, value);
    }

    const response = await host.fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-cc-cli-build": formatBuildStamp(BUILD_INFO),
        authorization: `Bearer ${params.token}`,
      },
      timeoutMs: HELP_CONTEXT_TIMEOUT_MS,
    });
    if (!response.ok) return [];

    const body: unknown = await response.json();
    const parsed = responseSchema.safeParse(body);
    return parsed.success ? parsed.data.blocks : [];
  } catch {
    return [];
  }
}
