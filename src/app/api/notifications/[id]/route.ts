import { NextResponse } from "next/server";
import { markReadRequestSchema } from "@/lib/schemas";
import {
  markAsRead,
  deleteNotification,
  notificationExists,
} from "@/lib/notification-db";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

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
