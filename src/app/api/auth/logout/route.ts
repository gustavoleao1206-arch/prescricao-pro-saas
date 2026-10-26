import { ok, route } from "@/lib/api";
import { destroySession, getSessionUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export const POST = route(async () => {
  const user = await getSessionUser();
  await destroySession();
  if (user) await logAudit({ actorId: user.id, actorRole: user.role, action: "auth.logout" });
  return ok({ message: "Sessão encerrada." });
});
