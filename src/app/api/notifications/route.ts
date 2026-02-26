import { NextResponse } from "next/server";
import { getNotificationsQuerySchema } from "@/lib/schemas";
import { getNotifications } from "@/lib/notification-db";
import { withTracing } from "@/lib/logging";
import type { ApiError } from "@/types";

export const dynamic = "force-dynamic";

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
