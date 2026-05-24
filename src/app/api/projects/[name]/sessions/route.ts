export const dynamic = "force-dynamic";

export {
  listSessions as GET,
  createSession as POST,
  deleteSessionRoute as DELETE,
} from "@/lib/sessions/route-handlers";
