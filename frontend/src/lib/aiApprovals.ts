import type { AIAction } from "@/lib/api";

/** Who may answer an action. The API enforces the same rule; this only decides what to offer. */
export function canRespondToAction(action: Pick<AIAction, "status" | "approval_level">, hasRole: (role: "admin" | "operator") => boolean) {
  const needsAdmin = action.approval_level >= 3;
  return action.status === "pending" && hasRole("operator") && (!needsAdmin || hasRole("admin"));
}
