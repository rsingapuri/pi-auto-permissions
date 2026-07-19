import { join } from "node:path";
import {
  createBashToolDefinition,
  getAgentDir,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  registerPermissionCommands,
  type PermissionCommandSnapshot,
  type PermissionCommandsHost,
} from "./commands/index.ts";
import {
  assertRevision,
  isPermissionMode,
  type EnforcementBackend,
  type SessionCheckpoint,
  type SessionInitialization,
} from "./domain.ts";
import { GuardianReviewEngine, type GuardianTranscriptItem } from "./guardian/index.ts";
import { createPiGuardianModelCall, guardianTranscriptFromSession } from "./pi/index.ts";
import {
  createDangerousCommandDetector,
  type DangerousCommandDetector,
} from "./policy/dangerous-command.ts";
import { StaticPathPolicy } from "./policy/path-policy.ts";
import { PermissionEngine } from "./runtime/index.ts";
import {
  createProductionSandboxController,
  type SandboxController,
  type SandboxStatus,
} from "./sandbox/index.ts";
import { GlobalConfigStore } from "./state/index.ts";
import {
  registerGuardedBashTool,
  registerPermissionToolGate,
  type GuardedBashRuntime,
  type PermissionToolGateRuntime,
} from "./tools/index.ts";

export const SESSION_CHECKPOINT_ENTRY = "pi-auto-permissions/session-v1";
export const PERMISSION_STATUS_KEY = "pi-auto-permissions";
export const GLOBAL_STATE_DIRECTORY = "pi-auto-permissions";
export const GLOBAL_STATE_FILE = "state.json";

type PathPolicyPort = Pick<StaticPathPolicy, "classify">;

export interface PermissionExtensionDependencies {
  readonly getAgentDir: () => string;
  readonly createConfigStore: (configPath: string) => GlobalConfigStore;
  readonly createPathPolicy: (
    cwd: string,
    deniedRoots: readonly string[],
  ) => Promise<PathPolicyPort>;
  readonly createDangerousCommandDetector: () => Promise<DangerousCommandDetector>;
  readonly createSandbox: (options: {
    cwd: string;
    additionalDenyWrite: readonly string[];
  }) => SandboxController;
  readonly createGuardian: (ctx: ExtensionContext) => GuardianReviewEngine;
  readonly transcript: (ctx: ExtensionContext) => readonly GuardianTranscriptItem[];
  readonly createBashDefinition: (
    cwd: string,
    operations?: BashOperations,
  ) => ReturnType<typeof createBashToolDefinition>;
}

const DEFAULT_DEPENDENCIES: PermissionExtensionDependencies = {
  getAgentDir,
  createConfigStore: (configPath) => new GlobalConfigStore({ configPath }),
  createPathPolicy: (cwd, deniedRoots) =>
    StaticPathPolicy.create({ cwd, workspaceRoots: [cwd], deniedRoots }),
  createDangerousCommandDetector,
  createSandbox: (options) => createProductionSandboxController(options),
  createGuardian: (ctx) =>
    new GuardianReviewEngine({ callModel: createPiGuardianModelCall(ctx.modelRegistry) }),
  transcript: (ctx) => guardianTranscriptFromSession(ctx.sessionManager),
  createBashDefinition: (cwd, operations) =>
    createBashToolDefinition(cwd, operations === undefined ? {} : { operations }),
};

/** Factory exported so the E2E suite can inject deterministic OS/model ports. */
export function createPermissionExtension(
  dependencyOverrides: Partial<PermissionExtensionDependencies> = {},
): (pi: ExtensionAPI) => void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };

  return (pi: ExtensionAPI): void => {
    const stateDirectory = join(dependencies.getAgentDir(), GLOBAL_STATE_DIRECTORY);
    const configPath = join(stateDirectory, GLOBAL_STATE_FILE);
    const configStore = dependencies.createConfigStore(configPath);
    let active: ActivePermissionSession | null = null;

    const activeRuntime = (): ActivePermissionSession | null => active;
    registerGuardedBashTool(pi, activeRuntime);
    registerPermissionToolGate(pi, activeRuntime);
    registerPermissionCommands(pi, createCommandsHost(pi, () => active));

    pi.on("session_start", async (event, ctx) => {
      const previous = active;
      active = null;
      if (previous !== null) {
        await previous.close().catch((error) => {
          ctx.ui.notify(`Previous permission session cleanup failed: ${errorMessage(error)}`, "warning");
        });
      }
      const initialization = sessionInitialization(event.reason, ctx.sessionManager.getBranch());
      const sandbox = safeCreateSandbox(dependencies, ctx.cwd, stateDirectory, configPath);

      const [sandboxResult, pathResult, detectorResult] = await Promise.allSettled([
        sandbox.start(),
        dependencies.createPathPolicy(ctx.cwd, [
          stateDirectory,
          configPath,
          `${stateDirectory}.lock`,
        ]),
        dependencies.createDangerousCommandDetector(),
      ]);
      const sandboxStatus =
        sandboxResult.status === "fulfilled"
          ? sandboxResult.value
          : failedSandboxStatus("initialization", sandboxResult.reason);
      const backend = backendFromStatus(sandboxStatus);
      const pathPolicy: PathPolicyPort =
        pathResult.status === "fulfilled" ? pathResult.value : FAIL_CLOSED_FILE_POLICY;
      const detector = detectorResult.status === "fulfilled" ? detectorResult.value : null;

      try {
        const engine = new PermissionEngine({
          configStore,
          pathPolicy,
          guardian: dependencies.createGuardian(ctx),
          sessionId: ctx.sessionManager.getSessionId(),
          sessionInitialization: initialization,
          dangerousCommandDetector: detector,
        });
        engine.setBackend(backend);
        active = new ActivePermissionSession(
          engine,
          sandbox,
          ctx.cwd,
          dependencies.transcript,
          dependencies.createBashDefinition,
        );
        const permissionStatus = await updateStatus(ctx, engine);
        notifyBackendFallback(ctx, sandboxStatus, permissionStatus);
        if (pathResult.status === "rejected") {
          ctx.ui.notify(
            "Direct-file path policy could not initialize; Auto write/edit actions will be denied.",
            "error",
          );
        }
      } catch (error) {
        try {
          detector?.close();
        } catch {
          // Initialization is already failing; cleanup must not prevent the
          // remaining guardrail from becoming visibly fail-closed.
        }
        await sandbox.shutdown().catch(() => undefined);
        active = null;
        ctx.ui.setStatus(PERMISSION_STATUS_KEY, "Permissions: Auto (unavailable)");
        ctx.ui.notify(`Permission guard initialization failed: ${errorMessage(error)}`, "error");
      }
    });

    pi.on("turn_start", (event) => {
      active?.startTurn(event.turnIndex, event.timestamp);
    });

    pi.on("turn_end", () => {
      active?.endTurn();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const closing = active;
      active = null;
      await closing?.close().catch((error) => {
        ctx.ui.notify(`Permission session cleanup failed: ${errorMessage(error)}`, "warning");
      });
    });
  };
}

export default createPermissionExtension();

class ActivePermissionSession implements GuardedBashRuntime, PermissionToolGateRuntime {
  readonly local: ReturnType<typeof createBashToolDefinition>;
  readonly sandboxed: ReturnType<typeof createBashToolDefinition>;
  private currentTurn: string | undefined;
  private reviewGeneration = new AbortController();
  private closed = false;

  constructor(
    readonly engine: PermissionEngine,
    private readonly sandbox: SandboxController,
    cwd: string,
    private readonly transcriptBuilder: PermissionExtensionDependencies["transcript"],
    createBashDefinition: PermissionExtensionDependencies["createBashDefinition"],
  ) {
    this.local = createBashDefinition(cwd);
    this.sandboxed = createBashDefinition(cwd, sandbox.operations);
  }

  startTurn(turnIndex: number, timestamp: number): void {
    this.endTurn();
    this.currentTurn = `${this.engineStatusSessionId()}:${turnIndex}:${timestamp}`;
  }

  endTurn(): void {
    if (this.currentTurn !== undefined) this.engine.clearTurn(this.currentTurn);
    this.currentTurn = undefined;
  }

  turnId(toolCallId: string): string {
    return this.currentTurn ?? `${this.engineStatusSessionId()}:tool:${toolCallId.slice(0, 256)}`;
  }

  transcript(ctx: ExtensionContext): readonly GuardianTranscriptItem[] {
    return this.transcriptBuilder(ctx);
  }

  signal(external: AbortSignal | undefined): AbortSignal | undefined {
    if (external === undefined) return this.reviewGeneration.signal;
    return AbortSignal.any([external, this.reviewGeneration.signal]);
  }

  invalidateReviews(): void {
    this.reviewGeneration.abort();
    this.reviewGeneration = new AbortController();
  }

  async refreshBackend(ctx: ExtensionContext): Promise<void> {
    const status = this.sandbox.status();
    const current = this.engine.sessionState.backend;
    if (
      current === "sandboxed" &&
      (status.kind === "failed" || status.kind === "closing" || status.kind === "closed")
    ) {
      this.engine.setBackend("unavailable");
      this.invalidateReviews();
    }
    await this.refreshStatus(ctx);
  }

  async refreshStatus(ctx: ExtensionContext): Promise<void> {
    await updateStatus(ctx, this.engine).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reviewGeneration.abort();
    this.endTurn();
    this.engine.shutdown();
    await this.sandbox.shutdown();
  }

  private engineStatusSessionId(): string {
    return this.engine.sessionIdentifier.slice(0, 220);
  }
}

function createCommandsHost(
  pi: ExtensionAPI,
  getActive: () => ActivePermissionSession | null,
): PermissionCommandsHost {
  const requireActive = (): ActivePermissionSession => {
    const session = getActive();
    if (session === null) throw new Error("permission session is not initialized");
    return session;
  };
  const checkpoint = (session: ActivePermissionSession): void => {
    pi.appendEntry(SESSION_CHECKPOINT_ENTRY, session.engine.checkpoint);
  };

  return {
    async readSnapshot(): Promise<PermissionCommandSnapshot> {
      const global = await requireActive().engine.readGlobal();
      return global.health === "fault"
        ? { health: "fault", error: global.error }
        : { health: "healthy", reviewer: global.config.reviewer };
    },
    async setRequestedMode(mode, _ctx): Promise<void> {
      const session = requireActive();
      await session.engine.setRequestedMode(mode);
      session.invalidateReviews();
      checkpoint(session);
    },
    async setReviewerAndAuto(selection, _ctx): Promise<void> {
      const session = requireActive();
      await session.engine.setReviewerAndAuto(selection);
      session.invalidateReviews();
      checkpoint(session);
    },
    async setEnabled(enabled, _ctx): Promise<void> {
      const session = requireActive();
      await session.engine.setEnabled(enabled);
      session.invalidateReviews();
    },
    updateStatus: async (ctx: ExtensionCommandContext): Promise<void> => {
      await updateStatus(ctx, requireActive().engine);
    },
  };
}

async function updateStatus(
  ctx: ExtensionContext,
  engine: PermissionEngine,
): Promise<Awaited<ReturnType<PermissionEngine["status"]>>> {
  const status = await engine.status();
  ctx.ui.setStatus(PERMISSION_STATUS_KEY, `Permissions: ${status.label}`);
  return status;
}

function sessionInitialization(
  reason: "startup" | "reload" | "new" | "resume" | "fork",
  branch: readonly SessionEntry[],
): SessionInitialization {
  if (reason !== "reload") return { kind: "fresh" };
  const checkpoint = findLatestCheckpoint(branch);
  return checkpoint === undefined ? { kind: "fresh" } : { kind: "reload", checkpoint };
}

export function findLatestCheckpoint(
  branch: readonly SessionEntry[],
): SessionCheckpoint | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== SESSION_CHECKPOINT_ENTRY) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (!isPermissionMode(record.requestedMode)) continue;
    try {
      assertRevision(record.revision, "session checkpoint revision");
    } catch {
      continue;
    }
    return { requestedMode: record.requestedMode, revision: record.revision };
  }
  return undefined;
}

function safeCreateSandbox(
  dependencies: PermissionExtensionDependencies,
  cwd: string,
  stateDirectory: string,
  configPath: string,
): SandboxController {
  try {
    return dependencies.createSandbox({
      cwd,
      additionalDenyWrite: [stateDirectory, configPath, `${stateDirectory}.lock`],
    });
  } catch (error) {
    return new FailedSandboxController(errorMessage(error));
  }
}

function backendFromStatus(status: SandboxStatus): EnforcementBackend {
  if (status.kind === "sandboxed") return "sandboxed";
  if (status.kind === "review-only") return "review-only";
  return "unavailable";
}

function failedSandboxStatus(
  phase: "initialization",
  error: unknown,
): Extract<SandboxStatus, { kind: "failed" }> {
  return { kind: "failed", phase, error: errorMessage(error) };
}

function notifyBackendFallback(
  ctx: ExtensionContext,
  sandboxStatus: SandboxStatus,
  permissionStatus: Awaited<ReturnType<PermissionEngine["status"]>>,
): void {
  if (!permissionStatus.label.startsWith("Auto")) return;
  if (sandboxStatus.kind === "review-only") {
    ctx.ui.notify(
      `OS sandboxing is unavailable on ${sandboxStatus.platform}; Auto will model-review every shell command.`,
      "warning",
    );
  } else if (sandboxStatus.kind === "failed") {
    ctx.ui.notify(
      `Auto shell sandbox is unavailable (${sandboxStatus.phase}); Auto shell commands will be denied.`,
      "error",
    );
  }
}

const FAIL_CLOSED_FILE_POLICY: PathPolicyPort = Object.freeze({
  classify: async ({ toolName }) =>
    ["read", "grep", "find", "ls"].includes(toolName)
      ? { disposition: "admit" as const, reason: "known read-only file tool" }
      : { disposition: "deny" as const, reason: "path policy unavailable" },
});

class FailedSandboxController implements SandboxController {
  readonly operations: BashOperations = {
    exec: async () => {
      throw new Error("Auto sandbox is unavailable");
    },
  };
  private current: SandboxStatus;

  constructor(error: string) {
    this.current = failedSandboxStatus("initialization", error);
  }

  async start(): Promise<SandboxStatus> {
    return this.status();
  }

  status(): SandboxStatus {
    return { ...this.current };
  }

  async shutdown(): Promise<void> {
    this.current = { kind: "closed" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
