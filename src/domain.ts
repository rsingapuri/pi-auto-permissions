import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const CONFIG_VERSION = 1 as const;

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

type MissingThinkingLevel = Exclude<ModelThinkingLevel, (typeof THINKING_LEVELS)[number]>;
const ALL_THINKING_LEVELS_ARE_LISTED: MissingThinkingLevel extends never ? true : never = true;
void ALL_THINKING_LEVELS_ARE_LISTED;

export type PermissionMode = "auto" | "unrestricted";
export type EnforcementBackend = "sandboxed" | "review-only" | "unavailable";
export type EffectiveMode = "disabled" | "unrestricted" | "unrestricted-unavailable" | "auto" | "fault";
export type AdmissionDisposition = "admit" | "review" | "deny";

export interface ReviewerSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

export interface GlobalConfig {
  version: typeof CONFIG_VERSION;
  enabled: boolean;
  reviewer: ReviewerSelection | null;
  revision: number;
}

export interface HealthyGlobalState {
  health: "missing" | "valid";
  config: GlobalConfig;
}

export interface FaultedGlobalState {
  health: "fault";
  error: string;
  revisionHint?: number;
  /** A fully validated config whose health is faulted only by revision metadata. */
  recoverableConfig?: GlobalConfig;
}

export type GlobalState = HealthyGlobalState | FaultedGlobalState;

export interface SessionState {
  requestedMode: PermissionMode;
  revision: number;
  backend: EnforcementBackend | null;
  alive: boolean;
}

export interface SessionCheckpoint {
  requestedMode: PermissionMode;
  revision: number;
}

export type SessionInitialization =
  | { kind: "fresh" }
  | { kind: "reload"; checkpoint?: SessionCheckpoint };

export interface ReviewBindingState {
  globalRevision: number;
  sessionRevision: number;
  backend: EnforcementBackend;
  sessionId: string;
}

export const DEFAULT_GLOBAL_CONFIG: Readonly<GlobalConfig> = Object.freeze({
  version: CONFIG_VERSION,
  enabled: true,
  reviewer: null,
  revision: 0,
});

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "auto" || value === "unrestricted";
}

export function reviewerSelectionsEqual(
  left: ReviewerSelection | null,
  right: ReviewerSelection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.thinkingLevel === right.thinkingLevel
  );
}

export function cloneReviewerSelection(selection: ReviewerSelection | null): ReviewerSelection | null {
  return selection === null ? null : { ...selection };
}

export function cloneGlobalConfig(config: Readonly<GlobalConfig>): GlobalConfig {
  return {
    version: CONFIG_VERSION,
    enabled: config.enabled,
    reviewer: cloneReviewerSelection(config.reviewer),
    revision: config.revision,
  };
}

export function createSessionState(initialization: SessionInitialization = { kind: "fresh" }): SessionState {
  if (initialization.kind === "reload" && initialization.checkpoint !== undefined) {
    assertRevision(initialization.checkpoint.revision, "session checkpoint revision");
    if (!isPermissionMode(initialization.checkpoint.requestedMode)) {
      throw new TypeError("session checkpoint requested mode is invalid");
    }
    return {
      requestedMode: initialization.checkpoint.requestedMode,
      revision: nextRevision(initialization.checkpoint.revision),
      backend: null,
      alive: true,
    };
  }

  return {
    requestedMode: "auto",
    revision: 0,
    backend: null,
    alive: true,
  };
}

export function checkpointSession(state: Readonly<SessionState>): SessionCheckpoint {
  return { requestedMode: state.requestedMode, revision: state.revision };
}

export function setRequestedMode(state: Readonly<SessionState>, requestedMode: PermissionMode): SessionState {
  if (!isPermissionMode(requestedMode)) throw new TypeError("requested mode is invalid");
  return updateSessionState(state, { requestedMode });
}

export function setSessionBackend(
  state: Readonly<SessionState>,
  backend: EnforcementBackend | null,
): SessionState {
  if (backend !== null && backend !== "sandboxed" && backend !== "review-only" && backend !== "unavailable") {
    throw new TypeError("session backend is invalid");
  }
  return updateSessionState(state, { backend });
}

export function setSessionAlive(state: Readonly<SessionState>, alive: boolean): SessionState {
  return updateSessionState(state, { alive });
}

export function effectiveMode(global: Readonly<GlobalState>, session: Readonly<SessionState>): EffectiveMode {
  if (global.health !== "fault" && global.config.enabled === false) return "disabled";
  if (session.requestedMode === "unrestricted") return "unrestricted";
  if (global.health === "fault") return "fault";
  if (global.config.reviewer === null) return "unrestricted-unavailable";
  return "auto";
}

export function nextRevision(revision: number): number {
  assertRevision(revision, "revision");
  if (revision === Number.MAX_SAFE_INTEGER) throw new RangeError("revision is exhausted");
  return revision + 1;
}

export function assertRevision(value: unknown, label = "revision"): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function updateSessionState(
  state: Readonly<SessionState>,
  patch: Partial<Pick<SessionState, "requestedMode" | "backend" | "alive">>,
): SessionState {
  const requestedMode = patch.requestedMode ?? state.requestedMode;
  const backend = patch.backend === undefined ? state.backend : patch.backend;
  const alive = patch.alive ?? state.alive;

  if (requestedMode === state.requestedMode && backend === state.backend && alive === state.alive) {
    return state as SessionState;
  }

  return {
    requestedMode,
    backend,
    alive,
    revision: nextRevision(state.revision),
  };
}
