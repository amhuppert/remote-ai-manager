import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "@/lib/config";
import { pushNotificationConfigSchema } from "@/lib/schemas";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** GET /api/push-notification — return current push notification config */
export const GET = withTracing(async () => {
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
export const PUT = withTracing(async (request: Request) => {
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
});
