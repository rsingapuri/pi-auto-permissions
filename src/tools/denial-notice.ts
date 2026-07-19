import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Keep denial feedback visible to the user without exposing tool arguments in
 * a notification. The model still receives the fixed denial result separately.
 */
export function notifyPermissionDenied(
  ctx: Pick<ExtensionContext, "ui">,
  toolName: string,
  reviewReason?: string,
): void {
  try {
    const diagnostic = reviewReason === undefined ? "" : ` Guardian result: ${reviewReason}.`;
    ctx.ui.notify(
      `Permission denied: ${toolName} action was not executed.${diagnostic}`,
      "warning",
    );
  } catch {
    // A notification failure must not change the fixed fail-closed denial.
  }
}
