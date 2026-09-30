import { describe, expect, it } from "vitest";
import { createSubscriptionControlsHandlers } from "./controls-route-handlers";
import { conversationSubscriptionSchema } from "./schemas";

const recipient = { projectPath: "/project", conversationId: "conversation" };
const subscription = conversationSubscriptionSchema.parse({
  id: "sub",
  recipient,
  source: { kind: "ticket", id: "ticket" },
  reason: "Follow decisions",
  mode: "passive",
  eventKinds: null,
  expiresAt: null,
  status: "following",
  cursor: null,
  createdAt: "now",
  updatedAt: "now",
  unfollowedAt: null,
  pausedAt: null,
  missingAt: null,
  lastError: null,
});
const context = {
  params: Promise.resolve({ subscriptionId: "sub", deliveryId: "delivery" }),
};
function fixture() {
  let enabled = true;
  let writes = 0;
  const handlers = createSubscriptionControlsHandlers({
    resolve: async () => ({ ok: true as const, value: recipient }),
    getControls: () => ({
      async subscribe() {
        writes++;
        return subscription;
      },
      async get() {
        return subscription;
      },
      async pause() {
        writes++;
        return { ...subscription, pausedAt: "now" };
      },
      async resume() {
        return subscription;
      },
      async setMode() {
        return subscription;
      },
      async cancel() {
        return subscription;
      },
      async unfollow() {
        return subscription;
      },
      async getPreferences() {
        return { hintsEnabled: enabled };
      },
      async setHintsEnabled(_recipient, value) {
        enabled = value;
        return { hintsEnabled: value };
      },
      async markDeliveryRead() {
        writes++;
        return true;
      },
      async getReadAt() {
        return null;
      },
      async listReadAt() {
        return new Map();
      },
    }),
    async getDetail() {
      return { subscription, wait: null, batch: null };
    },
    async pendingCount() {
      return 3;
    },
    now: () => "2026-09-30T00:00:00.000Z",
  });
  return { handlers, writes: () => writes };
}
describe("subscription controls HTTP", () => {
  it("rejects unsupported selections and unknown control actions", async () => {
    const { handlers, writes } = fixture();
    const response = await handlers.subscribePOST(
      new Request("http://test", {
        method: "POST",
        body: JSON.stringify({
          source: subscription.source,
          reason: "Follow",
          eventKinds: ["notepad-content-revised"],
        }),
      }),
      context,
    );
    expect(response.status).toBe(400);
    const invalid = await handlers.controlPATCH(
      new Request("http://test", {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
      }),
      context,
    );
    expect(invalid.status).toBe(400);
    expect(writes()).toBe(0);
  });
  it("keeps hint summary read-only and stores the explicit preference", async () => {
    const { handlers, writes } = fixture();
    expect(
      await (
        await handlers.summaryGET(new Request("http://test"), context)
      ).json(),
    ).toEqual({ pendingCount: 3, hintsEnabled: true });
    expect(writes()).toBe(0);
    await handlers.preferencesPATCH(
      new Request("http://test", {
        method: "PATCH",
        body: JSON.stringify({ hintsEnabled: false }),
      }),
      context,
    );
    expect(
      await (
        await handlers.summaryGET(new Request("http://test"), context)
      ).json(),
    ).toEqual({ pendingCount: 3, hintsEnabled: false });
  });
  it("does not accept malformed JSON as a mutation", async () => {
    const { handlers, writes } = fixture();
    expect(
      (
        await handlers.subscribePOST(
          new Request("http://test", { method: "POST", body: "{" }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(writes()).toBe(0);
  });
});
