import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GET } from "./route-handlers";
import { backendCatalogResponseSchema } from "./catalog";

// GET is withTracing-wrapped, so it takes the (request, routeContext) shape
// Next.js hands a route handler. The catalog route reads neither, but the
// wrapper does — give it a real request and an empty-params context.
function callGet(): Promise<Response> {
  return GET(new Request("http://localhost/api/agent-backends"), {
    params: Promise.resolve({}),
  });
}

describe("GET /api/agent-backends", () => {
  it("serves the registered backend catalog and Zod-parses on the wire shape", async () => {
    const response = await callGet();
    expect(response.status).toBe(200);

    const parsed = backendCatalogResponseSchema.parse(await response.json());
    const ids = parsed.backends.map((b) => b.id);
    expect(ids).toEqual(["claude", "codex"]);

    const claude = parsed.backends[0]!;
    expect(claude.label).toBe("Claude");
    expect(claude.toneToken).toBe("cyan");
    expect(claude.skillTriggerPrefix).toBe("/");
    expect(claude.defaultModelId).toBe("opus");
    expect(claude.models.map((m) => m.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(claude.capabilities?.queue.deliveryTiming).toBe("in_turn");

    const codex = parsed.backends[1]!;
    expect(codex.toneToken).toBe("violet");
    expect(codex.skillTriggerPrefix).toBe("$");
    expect(codex.defaultModelId).toBe("gpt-5.4");
    expect(codex.capabilities?.queue.deliveryTiming).toBe("next_turn");
  });

  it("serves metadata and capability labels only — no provider config payloads", async () => {
    const response = await callGet();
    // Inspect the RAW wire keys (not a Zod-stripped copy) so a leaked
    // adapter/config payload field fails instead of being silently dropped.
    const raw = z
      .object({ backends: z.array(z.record(z.string(), z.unknown())) })
      .parse(await response.json());
    for (const entry of raw.backends) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "capabilities",
          "defaultModelId",
          "defaultTimeoutMs",
          "id",
          "label",
          "models",
          "skillTriggerPrefix",
          "toneToken",
        ].sort(),
      );
    }
  });
});
