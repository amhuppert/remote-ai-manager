import { describe, expect, it, vi } from "vitest";
import { elementAt } from "@/lib/shared/testing/element-at";
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
    expect(ids).toEqual(["claude", "codex", "cursor"]);

    const claude = elementAt(parsed.backends, 0);
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

    const codex = elementAt(parsed.backends, 1);
    expect(codex.toneToken).toBe("violet");
    expect(codex.skillTriggerPrefix).toBe("$");
    expect(codex.defaultModelId).toBe("gpt-6-sol");
    expect(codex.capabilities?.queue.deliveryTiming).toBe("in_turn");

    const cursor = elementAt(parsed.backends, 2);
    expect(cursor.label).toBe("Cursor");
    expect(cursor.defaultModelId).toBe("composer-2.5");
    expect(cursor.capabilities?.queue).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
    expect(cursor.nativeMemory.mechanism).toBe("none");
    if (cursor.nativeMemory.mechanism !== "none") return;
    expect(cursor.executionWarnings).toEqual([
      "Live steering accepts text; attachments and rejected input wait for the next turn. Unconfirmed deliveries require review. Mid-turn questions use CC's question tool and expire after five minutes; native Cursor questions are unavailable.",
      cursor.nativeMemory.reason,
      "Provider tasks continue within the current turn. Background completion after a turn ends is unavailable; interrupted task outcomes are unknown and are reported when the conversation next runs.",
      "Network and native tool-approval limits are not enforced.",
      "Cost is Cursor's billed charge, fetched after each turn and settled late when billing lags. Per-turn attribution is inferred from the provider's usage entries and can stay unknown; accounts without the usage API report no cost at all.",
    ]);
    // Facet presence is what the facet-gated pickers read; the wire has to
    // carry it or they would have to guess.
    expect(cursor.facets).toEqual({ conversation: true, tasks: true });
    expect(claude.facets).toEqual({ conversation: true, tasks: true });
  });

  // The Cursor credential lives in the server environment and reaches the
  // adapter only. A sentinel value proves the catalog — the one backend payload
  // every client surface consumes — never carries it (spec R12.1).
  it("never serves the Cursor credential, even with one present in the environment", async () => {
    const sentinel = "cursor-api-key-sentinel-8f2a1c";
    vi.stubEnv("CURSOR_API_KEY", sentinel);
    try {
      const body = await (await callGet()).text();
      expect(body).not.toContain(sentinel);
      expect(body).not.toMatch(/api[-_]?key/i);
    } finally {
      vi.unstubAllEnvs();
    }
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
          "execution",
          "executionWarnings",
          "facets",
          "id",
          "label",
          "models",
          // A declaration, not a provider payload: two enum-ish fields saying
          // whether CC disables this backend's own memory, which the Memory
          // Library has to disclose.
          "nativeMemory",
          "skillTriggerPrefix",
          "toneToken",
        ].sort(),
      );
    }
  });
});
