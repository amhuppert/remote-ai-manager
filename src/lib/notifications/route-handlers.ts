import { NextResponse } from "next/server";
import { withTracing } from "@/lib/logging";
import {
  getNotificationsQuerySchema,
  markReadRequestSchema,
} from "@/lib/notifications/schemas";
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteAllNotifications,
  deleteNotification,
  notificationExists,
} from "@/lib/notifications/repo";
import type { ApiError } from "@/lib/api/errors";
/** GET /api/notifications — query persisted notifications with optional filters */
export const GET = withTracing(async (request) => {
  const url = new URL(request.url);
  const rawParams: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    rawParams[key] = value;
  }

  const parsed = getNotificationsQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid query parameters",
        code: "INVALID_PARAMS",
      } satisfies ApiError,
      { status: 400 },
    );
  }

  const { unread, limit, offset } = parsed.data;
  const result = getNotifications({ unread, limit, offset });

  return NextResponse.json({
    notifications: result.notifications,
    total: result.total,
    unreadCount: result.unreadCount,
  });
});

/** PATCH /api/notifications/[id] — mark a notification as read */
export const PATCH = withTracing(async (request, { params }) => {
  const resolvedParams = await params;
  const id = resolvedParams["id"] ?? "";

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" } satisfies ApiError,
      { status: 400 },
    );
  }

  const parsed = markReadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Request body must contain { read: true }" } satisfies ApiError,
      { status: 400 },
    );
  }

  const exists = markAsRead(id);
  if (!exists) {
    return NextResponse.json(
      { error: "Notification not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true });
});

/** DELETE /api/notifications/[id] — dismiss a notification */
export const DELETE = withTracing(async (_request, { params }) => {
  const resolvedParams = await params;
  const id = resolvedParams["id"] ?? "";

  if (!notificationExists(id)) {
    return NextResponse.json(
      { error: "Notification not found" } satisfies ApiError,
      { status: 404 },
    );
  }

  deleteNotification(id);
  return NextResponse.json({ success: true });
});

/** POST /api/notifications/mark-all-read — mark all as read then clear all notifications */
export const POST_MARK_ALL_READ = withTracing(async () => {
  const readCount = markAllAsRead();
  const deletedCount = deleteAllNotifications();
  return NextResponse.json({ success: true, readCount, deletedCount });
});
