import {
  createBashToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  GUARDIAN_DENIAL_MESSAGE,
  type GuardianTranscriptItem,
} from "../guardian/index.ts";
import type { PermissionEngine } from "../runtime/index.ts";
import { notifyPermissionDenied } from "./denial-notice.ts";

export const GUARDED_BASH_METADATA = Object.freeze({
  kind: "pi-auto-permissions-bash",
  policy: "codex-auto-workspace-write",
  schemaVersion: 1,
});

export const guardedBashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
  sandbox_permissions: Type.Optional(
    Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
      description:
        "Use require_escalated only when the fixed Auto sandbox cannot perform a necessary action. Permission review may deny it and never asks the user to override.",
    }),
  ),
});

export type GuardedBashInput = Static<typeof guardedBashSchema>;

export interface GuardedBashRuntime {
  readonly engine: PermissionEngine;
  readonly local: ReturnType<typeof createBashToolDefinition>;
  readonly sandboxed: ReturnType<typeof createBashToolDefinition>;
  turnId(toolCallId: string): string;
  transcript(ctx: ExtensionContext): readonly GuardianTranscriptItem[];
  signal(external: AbortSignal | undefined): AbortSignal | undefined;
  refreshBackend(ctx: ExtensionContext): Promise<void> | void;
}

/**
 * Override Pi's bash tool so routing is decided inside the final executor,
 * after schema validation, and the selected executor is entered at most once.
 */
export function registerGuardedBashTool(
  pi: ExtensionAPI,
  getRuntime: () => GuardedBashRuntime | null,
): void {
  const renderer = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...renderer,
    parameters: guardedBashSchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getRuntime();
      if (runtime === null) {
        notifyPermissionDenied(ctx, "bash");
        throw new Error(GUARDIAN_DENIAL_MESSAGE);
      }
      await runtime.refreshBackend(ctx);
      const reviewSignal = runtime.signal(signal);

      const decision = await runtime.engine.gate({
        toolCallId,
        turnId: runtime.turnId(toolCallId),
        toolName: "bash",
        input: params,
        cwd: ctx.cwd,
        toolMetadata: GUARDED_BASH_METADATA,
        transcript: () => runtime.transcript(ctx),
        ...(reviewSignal === undefined ? {} : { signal: reviewSignal }),
      });
      if (decision.outcome === "deny") {
        notifyPermissionDenied(ctx, "bash");
        if (decision.interruptTurn) ctx.abort();
        throw new Error(decision.message);
      }

      const executableParams = stripPermissionParameter(params);
      const executor = decision.route === "sandboxed" ? runtime.sandboxed : runtime.local;
      // Do not await or perform any other asynchronous work between the final
      // binding check in gate() and entering Pi's executor.
      try {
        return await executor.execute(toolCallId, executableParams, reviewSignal, onUpdate, ctx);
      } catch (error) {
        // A wrap/cleanup failure can mark the strong backend unavailable after
        // execution began. Reflect that transition immediately, never replay.
        if (decision.route === "sandboxed") await runtime.refreshBackend(ctx);
        throw error;
      }
    },
  });
}

function stripPermissionParameter(params: GuardedBashInput): {
  command: string;
  timeout?: number;
} {
  return params.timeout === undefined
    ? { command: params.command }
    : { command: params.command, timeout: params.timeout };
}
