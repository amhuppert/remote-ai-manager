import { describe, it, expect } from "vitest";
import { shouldSendPush } from "./push-notification";
import { pushNotificationConfigSchema } from "./schemas";

describe("pushNotificationConfigSchema", () => {
  it("parses a valid config", () => {
    const result = pushNotificationConfigSchema.safeParse({
      enabled: true,
      provider: "ntfy",
      serverUrl: "https://ntfy.sh",
      topic: "my-topic",
      triggers: {
        jobCompleted: true,
        waitingForInput: false,
        workflowCompleted: true,
        workflowHalted: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.topic).toBe("my-topic");
      expect(result.data.triggers.waitingForInput).toBe(false);
    }
  });

  it("applies defaults for missing fields", () => {
    const result = pushNotificationConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.provider).toBe("ntfy");
      expect(result.data.serverUrl).toBe("https://ntfy.sh");
      expect(result.data.topic).toBe("");
      expect(result.data.triggers.jobCompleted).toBe(true);
    }
  });

  it("rejects invalid provider", () => {
    const result = pushNotificationConfigSchema.safeParse({
      provider: "telegram",
    });
    expect(result.success).toBe(false);
  });
});

describe("shouldSendPush with config from schema defaults", () => {
  it("returns false for default config (enabled=false)", () => {
    const config = pushNotificationConfigSchema.parse({});
    expect(shouldSendPush(config, "job-completed")).toBe(false);
  });

  it("returns false when enabled but topic empty", () => {
    const config = pushNotificationConfigSchema.parse({ enabled: true });
    expect(shouldSendPush(config, "job-completed")).toBe(false);
  });

  it("returns true when enabled with topic", () => {
    const config = pushNotificationConfigSchema.parse({
      enabled: true,
      topic: "test",
    });
    expect(shouldSendPush(config, "job-completed")).toBe(true);
  });
});
