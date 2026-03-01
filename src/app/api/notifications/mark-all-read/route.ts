import { NextResponse } from "next/server";
import { markAllAsRead, deleteAllNotifications } from "@/lib/notification-db";
import { withTracing } from "@/lib/logging";

export const dynamic = "force-dynamic";

/** POST /api/notifications/mark-all-read — mark all as read then clear all notifications */
export const POST = withTracing(async () => {
  const readCount = markAllAsRead();
  const deletedCount = deleteAllNotifications();
  return NextResponse.json({ success: true, readCount, deletedCount });
});
