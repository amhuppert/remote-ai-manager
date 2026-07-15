// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { apiFetch, apiFetchOptional, mutationFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { installFetchFixture, type FetchFixture } from "./fetch-fixture";

const itemSchema = z.object({ id: z.string(), value: z.number() });

let fixture: FetchFixture | null = null;

afterEach(() => {
  fixture?.restore();
  fixture = null;
});

describe("installFetchFixture", () => {
  it("serves registered JSON to the real apiFetch (schema-validated)", async () => {
    fixture = installFetchFixture();
    fixture.json("GET", "/api/items/a", { id: "a", value: 1 });

    await expect(apiFetch("/api/items/a", itemSchema)).resolves.toEqual({
      id: "a",
      value: 1,
    });
  });

  it("matches on pathname, ignoring the query string for string patterns", async () => {
    fixture = installFetchFixture();
    fixture.json("GET", "/api/items/a", { id: "a", value: 1 });

    await expect(
      apiFetch("/api/items/a?scope=global", itemSchema),
    ).resolves.toEqual({ id: "a", value: 1 });
  });

  it("routes distinct methods on the same path independently", async () => {
    fixture = installFetchFixture();
    fixture.json("GET", "/api/items/a", { id: "a", value: 1 });
    fixture.json("POST", "/api/items/a", { id: "a", value: 2 });

    await expect(
      mutationFetch(
        "/api/items/a",
        "test-post",
        { method: "POST" },
        itemSchema,
      ),
    ).resolves.toEqual({ id: "a", value: 2 });
  });

  it("records requests with parsed JSON bodies for assertion", async () => {
    fixture = installFetchFixture();
    fixture.json("PUT", "/api/config", { ok: true });

    await mutationFetch("/api/config", "update-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: "sonnet" }),
    });

    const puts = fixture.requestsTo("PUT", "/api/config");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.jsonBody).toEqual({ defaultModel: "sonnet" });
    expect(puts[0]?.pathname).toBe("/api/config");
  });

  it("supports responder functions that see the recorded request", async () => {
    fixture = installFetchFixture();
    fixture.reply("GET", /\/api\/items\/\w+/, (req) => ({
      json: { id: req.pathname.split("/").at(-1), value: 7 },
    }));

    await expect(apiFetch("/api/items/xyz", itemSchema)).resolves.toEqual({
      id: "xyz",
      value: 7,
    });
  });

  it("later registrations for the same route win (mid-test data swap)", async () => {
    fixture = installFetchFixture();
    fixture.json("GET", "/api/items/a", { id: "a", value: 1 });
    fixture.json("GET", "/api/items/a", { id: "a", value: 2 });

    await expect(apiFetch("/api/items/a", itemSchema)).resolves.toEqual({
      id: "a",
      value: 2,
    });
  });

  it("serves non-2xx replies that the real fetcher shapes into ApiCallError", async () => {
    fixture = installFetchFixture();
    fixture.reply("GET", "/api/items/missing", {
      status: 500,
      json: { error: "boom", code: "kaput" },
    });

    const err = await apiFetch("/api/items/missing", itemSchema).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiCallError);
    expect((err as ApiCallError).message).toBe("boom");
    expect((err as ApiCallError).status).toBe(500);
  });

  it("lets apiFetchOptional observe a 404 as null", async () => {
    fixture = installFetchFixture();
    fixture.reply("GET", "/api/items/gone", { status: 404, json: {} });

    await expect(
      apiFetchOptional("/api/items/gone", itemSchema),
    ).resolves.toBeNull();
  });

  it("keeps pending routes unresolved forever", async () => {
    fixture = installFetchFixture();
    fixture.pending("GET", "/api/slow");

    const race = await Promise.race([
      apiFetch("/api/slow", itemSchema).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-pending"), 20)),
    ]);
    expect(race).toBe("still-pending");
  });

  it("rejects unmatched requests loudly and records them", async () => {
    fixture = installFetchFixture();
    fixture.json("GET", "/api/known", {});

    await expect(apiFetch("/api/unknown", itemSchema)).rejects.toThrow(
      /no fixture route.*GET \/api\/unknown/i,
    );
    expect(fixture.unmatched).toHaveLength(1);
    expect(fixture.unmatched[0]?.pathname).toBe("/api/unknown");
  });

  it("restore() reinstates the previous global fetch", () => {
    const before = globalThis.fetch;
    fixture = installFetchFixture();
    expect(globalThis.fetch).not.toBe(before);
    fixture.restore();
    expect(globalThis.fetch).toBe(before);
    fixture = null;
  });
});
