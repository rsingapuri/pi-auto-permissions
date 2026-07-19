import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Keep denial feedback visible to the user without exposing tool arguments in
 * a notification. The model still receives the fixed denial result separately.
 */
export function notifyPermissionDenied(
  ctx: Pick<ExtensionContext, "ui">,
  toolName: string,
): void {
  try {
    ctx.ui.notify(`Permission denied: ${toolName} action was not executed.`, "warning");
  } catch {
    // A notification failure must not change the fixed fail-closed denial.
  }
}
