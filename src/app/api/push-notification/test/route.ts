import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { sendPushNotification } from "@/lib/push-notification";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** POST /api/push-notification/test — send a test push notification */
export const POST = withTracing(async () => {
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
