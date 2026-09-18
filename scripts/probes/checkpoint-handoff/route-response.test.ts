import { describe, expect, it } from "vitest";
import { readProbeResponse } from "./route-response";

describe("probe route response decoding", () => {
  it("retains empty method-not-allowed responses for read-only prewarm evidence", async () => {
    await expect(
      readProbeResponse(new Response(null, { status: 405 })),
    ).resolves.toEqual({ status: 405, body: null });
  });
  it("retains a structured route response", async () => {
    await expect(
      readProbeResponse(
        Response.json({ message: { id: "queued" } }, { status: 200 }),
      ),
    ).resolves.toEqual({ status: 200, body: { message: { id: "queued" } } });
  });
  it("does not hide malformed nonempty response bodies", async () => {
    await expect(
      readProbeResponse(
        new Response("<html>startup error</html>", { status: 500 }),
      ),
    ).rejects.toThrow();
  });
});
