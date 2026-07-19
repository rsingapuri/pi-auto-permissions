import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Keep denial feedback visible to the user without exposing tool arguments in
 * a notification. The model still receives the fixed denial result separately.
 */
export function notifyPermissionDenied(
  ctx: Pick<ExtensionContext, "ui">,
  toolName: string,
  reason: string = "invalid_action",
  reviewReason?: string,
): void {
  try {
    if (reviewReason === "cancelled") return;
    const explicitDenial =
      reason === "invalid_action" ||
      reviewReason === "model_denied" ||
      reviewReason === "circuit_breaker";
    const prefix = explicitDenial ? "Permission denied" : "Permission enforcement failed";
    const diagnostic = reviewReason === undefined ? "" : ` Guardian result: ${reviewReason}.`;
    ctx.ui.notify(
      `${prefix}: ${toolName} action was not executed.${diagnostic}`,
      explicitDenial ? "warning" : "error",
    );
  } catch {
    // A notification failure must not change the fixed fail-closed denial.
  }
}
