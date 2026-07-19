import { canonicalizeAction, CanonicalizationError } from "../canonical.ts";
import {
  checkpointSession,
  createSessionState,
  effectiveMode,
  setRequestedMode as updateRequestedMode,
  setSessionAlive,
  setSessionBackend,
  type EnforcementBackend,
  type GlobalConfig,
  type GlobalState,
  type PermissionMode,
  type ReviewerSelection,
  type SessionCheckpoint,
  type SessionInitialization,
  type SessionState,
} from "../domain.ts";
import {
  GUARDIAN_DENIAL_MESSAGE,
  GuardianReviewEngine,
  guardianReviewBindingsEqual,
  type GuardianReviewBinding,
  type GuardianTranscriptItem,
} from "../guardian/index.ts";
import type { DangerousCommandDetector } from "../policy/dangerous-command.ts";
import type { StaticPathPolicy } from "../policy/path-policy.ts";
import type { GlobalConfigMutation, GlobalConfigStore } from "../state/config-store.ts";

export const SANDBOX_UNAVAILABLE_DENIAL_MESSAGE = GUARDIAN_DENIAL_MESSAGE;

export type PermissionExecutionRoute = "passthrough" | "sandboxed" | "local";

export interface PermissionAction {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly toolName: string;
  /** Kept live through review so an in-place mutation makes the binding stale. */
  readonly input: unknown;
  readonly cwd: string;
  readonly toolMetadata: unknown;
  /** Static file admission is valid only for Pi's actual built-in definition. */
  readonly builtInFileTool?: boolean;
  /** Built only if this action actually reaches Guardian review. */
  readonly transcript:
    | readonly GuardianTranscriptItem[]
    | (() => readonly GuardianTranscriptItem[]);
  readonly signal?: AbortSignal;
}

export interface PermissionAdmitDecision {
  readonly outcome: "admit";
  readonly route: PermissionExecutionRoute;
  readonly reviewed: boolean;
}

export interface PermissionDenyDecision {
  readonly outcome: "deny";
  readonly message: string;
  readonly reason:
    | "configuration_fault"
    | "invalid_action"
    | "sandbox_unavailable"
    | "review_denied"
    | "stale_binding";
  readonly interruptTurn: boolean;
}

export type PermissionDecision = PermissionAdmitDecision | PermissionDenyDecision;

export interface PermissionEngineOptions {
  readonly configStore: Pick<
    GlobalConfigStore,
    "read" | "setEnabled" | "setReviewer" | "repair"
  >;
  readonly pathPolicy: Pick<StaticPathPolicy, "classify">;
  readonly guardian: GuardianReviewEngine;
  readonly sessionId: string;
  readonly sessionInitialization?: SessionInitialization;
  readonly dangerousCommandDetector?: DangerousCommandDetector | null;
}

export interface PermissionStatus {
  readonly label:
    | "Off"
    | "Unrestricted"
    | "Auto"
    | "Auto (review-only)"
    | "Auto (sandbox unavailable)"
    | "Auto (configuration fault)";
  readonly global: GlobalState;
  readonly session: SessionState;
}

export class AutoUnavailableError extends Error {
  constructor(message = "Auto is unavailable until /perm-auto-model selects a model and thinking level") {
    super(message);
    this.name = "AutoUnavailableError";
  }
}

/**
 * Pure orchestration boundary for the permission state machine.  It classifies
 * and reviews, but never invokes a tool or starts a process.  Consequently an
 * executor can be reached only through an explicit `admit` result.
 */
export class PermissionEngine {
  private readonly configStore: PermissionEngineOptions["configStore"];
  private readonly pathPolicy: Pick<StaticPathPolicy, "classify">;
  private readonly guardian: GuardianReviewEngine;
  private readonly sessionId: string;
  private readonly dangerousCommandDetector: DangerousCommandDetector | null;
  private session: SessionState;

  constructor(options: PermissionEngineOptions) {
    if (options.sessionId.length === 0) throw new TypeError("sessionId must not be empty");
    this.configStore = options.configStore;
    this.pathPolicy = options.pathPolicy;
    this.guardian = options.guardian;
    this.sessionId = options.sessionId;
    this.dangerousCommandDetector = options.dangerousCommandDetector ?? null;
    this.session = createSessionState(options.sessionInitialization ?? { kind: "fresh" });
  }

  get sessionState(): SessionState {
    return { ...this.session };
  }

  get sessionIdentifier(): string {
    return this.sessionId;
  }

  get checkpoint(): SessionCheckpoint {
    return checkpointSession(this.session);
  }

  async readGlobal(): Promise<GlobalState> {
    return this.configStore.read();
  }

  setBackend(backend: EnforcementBackend): void {
    this.session = setSessionBackend(this.session, backend);
  }

  async setRequestedMode(mode: PermissionMode): Promise<void> {
    if (mode === "auto") {
      const global = await this.configStore.read();
      if (global.health === "fault" || global.config.reviewer === null) {
        throw new AutoUnavailableError(
          global.health === "fault"
            ? "Auto is unavailable while global permission state is faulted"
            : undefined,
        );
      }
    }
    this.session = updateRequestedMode(this.session, mode);
  }

  async setReviewerAndAuto(selection: ReviewerSelection): Promise<GlobalConfig> {
    const observed = await this.configStore.read();
    const committed =
      observed.health === "fault"
        ? await this.configStore.repair({
            enabled: observed.recoverableConfig?.enabled ?? true,
            reviewer: selection,
          })
        : await this.configStore.setReviewer(selection);
    // This transition occurs only after the complete tuple is durable.
    this.session = updateRequestedMode(this.session, "auto");
    return committed;
  }

  async setEnabled(enabled: boolean): Promise<GlobalConfig> {
    const observed = await this.configStore.read();
    if (observed.health === "fault") {
      const repair: GlobalConfigMutation = {
        enabled,
        reviewer: observed.recoverableConfig?.reviewer ?? null,
      };
      return this.configStore.repair(repair);
    }
    return this.configStore.setEnabled(enabled);
  }

  async status(): Promise<PermissionStatus> {
    const global = await this.configStore.read();
    const mode = effectiveMode(global, this.session);
    let label: PermissionStatus["label"];
    if (mode === "disabled") label = "Off";
    else if (mode === "unrestricted" || mode === "unrestricted-unavailable") {
      label = "Unrestricted";
    } else if (mode === "fault") {
      label = "Auto (configuration fault)";
    } else if (this.session.backend === "review-only") {
      label = "Auto (review-only)";
    } else if (this.session.backend === "sandboxed") {
      label = "Auto";
    } else {
      label = "Auto (sandbox unavailable)";
    }
    return { label, global, session: this.sessionState };
  }

  clearTurn(turnId: string): void {
    this.guardian.clearTurn(turnId);
  }

  shutdown(): void {
    this.session = setSessionAlive(this.session, false);
    this.dangerousCommandDetector?.close();
  }

  async gate(action: PermissionAction): Promise<PermissionDecision> {
    if (!this.session.alive) return this.denyAction(action, "stale_binding");

    let global: GlobalState;
    try {
      global = await this.configStore.read();
    } catch {
      return this.denyAction(action, "configuration_fault");
    }
    const mode = effectiveMode(global, this.session);

    if (mode === "disabled" || mode === "unrestricted" || mode === "unrestricted-unavailable") {
      return this.admitAction(
        action,
        action.toolName === "bash" ? "local" : "passthrough",
        false,
      );
    }
    if (this.guardian.isTurnInterrupted(action.turnId)) {
      return { ...deny("review_denied"), interruptTurn: true };
    }
    if (mode === "fault") return this.denyAction(action, "configuration_fault");

    if (action.toolName === "bash") return this.gateBash(action, global);

    if (action.builtInFileTool === true) {
      try {
        const pathDecision = await this.pathPolicy.classify({
          toolName: action.toolName,
          input: action.input,
        });
        if (pathDecision.disposition === "admit") {
          return this.admitAction(action, "passthrough");
        }
        if (pathDecision.disposition === "deny") {
          return this.denyAction(action, "invalid_action");
        }
      } catch {
        // Classification uncertainty receives Guardian review. The extension
        // startup fallback separately hard-denies all direct mutations when a
        // usable path policy could not be constructed.
      }
    }

    return this.review(action, global, "passthrough");
  }

  private async gateBash(action: PermissionAction, global: GlobalState): Promise<PermissionDecision> {
    const input = bashInput(action.input);
    if (input === null) return this.denyAction(action, "invalid_action");

    const backend = this.session.backend;
    if (backend === null || backend === "unavailable") {
      return this.denyAction(action, "sandbox_unavailable");
    }
    if (backend === "review-only") return this.review(action, global, "local");

    if (input.sandboxPermissions === "require_escalated") {
      return this.review(action, global, "local");
    }

    let requiresReview: boolean;
    try {
      // Parser initialization/detection uncertainty deliberately routes to
      // review. It never silently skips the pinned Codex dangerous rule.
      requiresReview =
        this.dangerousCommandDetector === null ||
        this.dangerousCommandDetector.detect(input.command) !== undefined;
    } catch {
      requiresReview = true;
    }

    // Codex separates approval from containment: danger requires approval,
    // but a default-permission command still runs in the workspace sandbox.
    // Only an explicit escalation is eligible for local execution.
    return requiresReview
      ? this.review(action, global, "sandboxed")
      : this.admitAction(action, "sandboxed");
  }

  private async review(
    action: PermissionAction,
    capturedGlobal: GlobalState,
    route: PermissionExecutionRoute,
  ): Promise<PermissionDecision> {
    if (
      capturedGlobal.health === "fault" ||
      capturedGlobal.config.reviewer === null ||
      this.session.backend === null
    ) {
      return this.denyAction(
        action,
        capturedGlobal.health === "fault" ? "configuration_fault" : "invalid_action",
      );
    }

    let canonicalAction: string;
    try {
      canonicalAction = canonicalizeLiveAction(action);
    } catch {
      return this.denyAction(action, "invalid_action");
    }

    const capturedBinding = bindingFrom(
      canonicalAction,
      capturedGlobal.config,
      this.session,
      this.sessionId,
    );
    if (capturedBinding === null) return this.denyAction(action, "invalid_action");

    const getCurrentBinding = async (): Promise<GuardianReviewBinding | null> => {
      if (!this.session.alive || this.session.backend === null) return null;
      const currentGlobal = await this.configStore.read();
      if (effectiveMode(currentGlobal, this.session) !== "auto" || currentGlobal.health === "fault") {
        return null;
      }
      let currentCanonicalAction: string;
      try {
        currentCanonicalAction = canonicalizeLiveAction(action);
      } catch {
        return null;
      }
      return bindingFrom(currentCanonicalAction, currentGlobal.config, this.session, this.sessionId);
    };

    let transcript: readonly GuardianTranscriptItem[];
    try {
      transcript =
        typeof action.transcript === "function" ? action.transcript() : action.transcript;
    } catch {
      return this.denyAction(action, "invalid_action");
    }

    let result;
    try {
      result = await this.guardian.review({
        turnId: action.turnId,
        binding: capturedBinding,
        transcript,
        ...(action.signal === undefined ? {} : { signal: action.signal }),
        getCurrentBinding,
      });
    } catch {
      return this.denyAction(action, "review_denied");
    }
    if (result.outcome === "deny") {
      return {
        outcome: "deny",
        message: result.message,
        reason: "review_denied",
        interruptTurn: result.interruptTurn,
      };
    }

    // The reviewer also checks before and after its call.  This final check is
    // intentionally owned by the outer gate and is the last await before the
    // caller synchronously enters the selected executor.
    let finalBinding: GuardianReviewBinding | null;
    try {
      finalBinding = await getCurrentBinding();
    } catch {
      return this.denyAction(action, "stale_binding");
    }
    if (finalBinding === null || !guardianReviewBindingsEqual(result.binding, finalBinding)) {
      return this.denyAction(action, "stale_binding");
    }
    return this.admitAction(action, route, true, true);
  }

  private admitAction(
    action: Pick<PermissionAction, "turnId">,
    route: PermissionExecutionRoute,
    accountAutoDecision = true,
    reviewed = false,
  ): PermissionDecision {
    // Every admission branch linearizes against lifecycle here, after its last
    // asynchronous classification/state read and before returning to Pi.
    if (!this.session.alive) return this.denyAction(action, "stale_binding");
    if (accountAutoDecision) {
      // This check and the breaker reset are synchronous, so no same-turn
      // denial can interleave after the check and before this admission's
      // linearization point.
      if (this.guardian.isTurnInterrupted(action.turnId)) {
        return { ...deny("review_denied"), interruptTurn: true };
      }
      this.guardian.recordPermissionNonDenial(action.turnId);
    }
    return admit(route, reviewed);
  }

  private denyAction(
    action: Pick<PermissionAction, "turnId">,
    reason: PermissionDenyDecision["reason"],
  ): PermissionDenyDecision {
    const breaker = this.guardian.recordPermissionDenial(action.turnId);
    return { ...deny(reason), interruptTurn: breaker.interruptTurn };
  }
}

function canonicalizeLiveAction(action: PermissionAction): string {
  try {
    return canonicalizeAction({
      toolName: action.toolName,
      arguments: action.input,
      cwd: action.cwd,
      toolMetadata: action.toolMetadata,
    }).json;
  } catch (error) {
    if (error instanceof CanonicalizationError) throw error;
    throw new CanonicalizationError("unsupported", "action could not be canonicalized");
  }
}

function bindingFrom(
  canonicalAction: string,
  global: GlobalConfig,
  session: SessionState,
  sessionId: string,
): GuardianReviewBinding | null {
  if (!session.alive || session.backend === null || global.reviewer === null) return null;
  return {
    canonicalAction,
    globalRevision: global.revision,
    sessionRevision: session.revision,
    backend: session.backend,
    sessionId,
    reviewer: { ...global.reviewer },
  };
}

function bashInput(
  value: unknown,
): { command: string; sandboxPermissions: "use_default" | "require_escalated" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string") return null;
  const permission = record.sandbox_permissions;
  if (
    permission !== undefined &&
    permission !== "use_default" &&
    permission !== "require_escalated"
  ) {
    return null;
  }
  return {
    command: record.command,
    sandboxPermissions: permission ?? "use_default",
  };
}

function admit(route: PermissionExecutionRoute, reviewed: boolean): PermissionAdmitDecision {
  return { outcome: "admit", route, reviewed };
}

function deny(reason: PermissionDenyDecision["reason"]): PermissionDenyDecision {
  return {
    outcome: "deny",
    message: GUARDIAN_DENIAL_MESSAGE,
    reason,
    interruptTurn: false,
  };
}
