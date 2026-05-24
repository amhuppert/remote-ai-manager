/**
 * Push-notification route handlers.
 *
 * - GET /api/push-notification — read current push notification config
 * - PUT /api/push-notification — write push notification config
 * - POST /api/push-notification/test — send a test push notification
 */

import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config/loader";
import { pushNotificationConfigSchema } from "@/lib/notifications/schemas";
import { sendPushNotification } from "@/lib/notifications/push";
import { withTracing } from "@/lib/logging";

/** GET /api/push-notification — return current push notification config */
export const getPushNotificationConfig = withTracing(async () => {
  try {
    const config = await readConfig();
    const pushConfig =
      config.pushNotification ?? pushNotificationConfigSchema.parse({});
    return NextResponse.json(pushConfig);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

/** PUT /api/push-notification — update push notification config */
export const updatePushNotificationConfig = withTracing(
  async (request: Request) => {
    try {
      const body: unknown = await request.json();
      const parsed = pushNotificationConfigSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Invalid push notification config",
            details: parsed.error.format(),
          },
          { status: 400 },
        );
      }

      const config = await readConfig();
      config.pushNotification = parsed.data;
      await writeConfig(config);

      return NextResponse.json(parsed.data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update config";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);

/** POST /api/push-notification/test — send a test push notification */
export const sendTestPushNotification = withTracing(async () => {
  try {
    const config = await readConfig();
    const pushConfig = config.pushNotification;

    if (!pushConfig?.enabled) {
      return NextResponse.json(
        { error: "Push notifications are not enabled" },
        { status: 400 },
      );
    }

    if (!pushConfig.topic) {
      return NextResponse.json(
        { error: "Push notification topic is not configured" },
        { status: 400 },
      );
    }

    await sendPushNotification(pushConfig, {
      trigger: "job-completed",
      title: "Test notification",
      message: "If you see this on your phone, push notifications are working!",
      projectName: "Command Center",
      sessionName: "test",
    });

    return NextResponse.json({
      success: true,
      message: "Test notification sent",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send test";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});
