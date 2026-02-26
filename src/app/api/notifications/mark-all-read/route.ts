import { NextResponse } from "next/server";
import { markAllAsRead } from "@/lib/notification-db";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** POST /api/notifications/mark-all-read — mark all notifications as read */
export const POST = withTracing(async () => {
  const count = markAllAsRead();
  return NextResponse.json({ success: true, count });
});
