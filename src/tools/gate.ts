import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { GuardianTranscriptItem } from "../guardian/index.ts";
import { GUARDIAN_DENIAL_MESSAGE } from "../guardian/index.ts";
import type { PermissionEngine } from "../runtime/index.ts";
import { notifyPermissionDenied } from "./denial-notice.ts";

const DIRECT_FILE_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "write", "edit"]);

export interface PermissionToolGateRuntime {
  readonly engine: PermissionEngine;
  turnId(toolCallId: string): string;
  transcript(ctx: ExtensionContext): readonly GuardianTranscriptItem[];
  signal(external: AbortSignal | undefined): AbortSignal | undefined;
  refreshStatus(ctx: ExtensionContext): Promise<void> | void;
}

/** Registers the non-bash gate. Bash is guarded in its overridden execute(). */
export function registerPermissionToolGate(
  pi: ExtensionAPI,
  getRuntime: () => PermissionToolGateRuntime | null,
): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") return;
    const runtime = getRuntime();
    if (runtime === null) {
      notifyPermissionDenied(ctx, event.toolName);
      return { block: true, reason: GUARDIAN_DENIAL_MESSAGE };
    }

    await runtime.refreshStatus(ctx);
    const info = findToolInfo(pi, event.toolName);
    const reviewSignal = runtime.signal(ctx.signal);
    const decision = await runtime.engine.gate({
      toolCallId: event.toolCallId,
      turnId: runtime.turnId(event.toolCallId),
      toolName: event.toolName,
      input: event.input,
      cwd: ctx.cwd,
      toolMetadata: canonicalToolMetadata(info, event.toolName),
      trustedFileTool: isTrustedStandardFileTool(info, event),
      transcript: () => runtime.transcript(ctx),
      ...(reviewSignal === undefined ? {} : { signal: reviewSignal }),
    });
    if (decision.outcome === "admit") return;
    notifyPermissionDenied(ctx, event.toolName, decision.reviewReason);
    if (decision.interruptTurn) ctx.abort();
    return { block: true, reason: decision.message };
  });
}

function findToolInfo(pi: ExtensionAPI, toolName: string): ToolInfo | undefined {
  return pi.getAllTools().find((candidate) => candidate.name === toolName);
}

function isTrustedStandardFileTool(info: ToolInfo | undefined, event: ToolCallEvent): boolean {
  if (!DIRECT_FILE_TOOL_NAMES.has(event.toolName) || info === undefined) return false;
  const { source, path } = info.sourceInfo;
  return (
    (source === "builtin" && path === `<builtin:${event.toolName}>`) ||
    (source === "sdk" && path === `<sdk:${event.toolName}>`)
  );
}

function canonicalToolMetadata(info: ToolInfo | undefined, toolName: string): unknown {
  if (info === undefined) return { name: toolName, source: "unknown" };
  return {
    name: info.name,
    description: info.description,
    parameters: info.parameters,
    sourceInfo: info.sourceInfo,
    ...(info.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: info.promptGuidelines }),
  };
}
