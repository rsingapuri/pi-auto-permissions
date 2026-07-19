import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { EnforcementBackend } from "../domain.ts";

export type SandboxFailurePhase =
  | "platform"
  | "configuration"
  | "dependencies"
  | "initialization"
  | "probe"
  | "runtime";

export type SandboxReviewOnlyReason = "unsupported-os" | "wsl1";

export type SandboxStatus =
  | { readonly kind: "new" }
  | { readonly kind: "initializing" }
  | {
      readonly kind: "sandboxed";
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "review-only";
      readonly reason: SandboxReviewOnlyReason;
      readonly platform: NodeJS.Platform;
    }
  | {
      readonly kind: "failed";
      readonly phase: SandboxFailurePhase;
      readonly error: string;
    }
  | { readonly kind: "closing" }
  | { readonly kind: "closed" };

export interface SandboxDependencyReport {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Narrow seam around Sandbox Runtime's process-global manager.
 *
 * Deliberately absent from this interface: SRT's ask callback, live config
 * updates, and raw manager state. The extension has no human-approval path and
 * owns one immutable sandbox configuration for the manager's whole lifetime.
 */
export interface SandboxRuntimePort {
  isSupportedPlatform(): boolean;
  checkDependencies(): SandboxDependencyReport;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrap(command: string, shell: string, signal: AbortSignal | undefined): Promise<string>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

export interface SandboxHost {
  readonly platform: NodeJS.Platform;
  readonly wslVersion?: string;
}

export interface SandboxController {
  /** Sandboxed operations are callable only after start() returns Sandboxed. */
  readonly operations: BashOperations;
  start(): Promise<SandboxStatus>;
  status(): SandboxStatus;
  shutdown(): Promise<void>;
}

export interface SandboxControllerOptions {
  readonly cwd: string;
  /** Absolute extension-owned durable state/lock paths to deny beneath writable roots. */
  readonly additionalDenyWrite?: readonly string[];
  readonly host: SandboxHost;
  readonly runtime: SandboxRuntimePort;
  readonly localOperations: BashOperations;
  readonly shell: string;
  readonly probeTimeoutSeconds?: number;
  /** Internal lifecycle hook: false permanently poisons process-global reuse. */
  readonly onClosed?: (runtimeReusable: boolean) => void;
}

export interface ProductionSandboxControllerOptions {
  readonly cwd: string;
  readonly additionalDenyWrite?: readonly string[];
}

export function backendForSandboxStatus(status: Readonly<SandboxStatus>): EnforcementBackend | null {
  if (status.kind === "sandboxed") return "sandboxed";
  if (status.kind === "review-only") return "review-only";
  return null;
}

export class SandboxUnavailableError extends Error {
  readonly status: SandboxStatus;

  constructor(status: SandboxStatus) {
    super(unavailableMessage(status));
    this.name = "SandboxUnavailableError";
    this.status = status;
  }
}

export class ProcessSandboxAlreadyOwnedError extends Error {
  constructor(message = "The process-global sandbox runtime already has an active owner") {
    super(message);
    this.name = "ProcessSandboxAlreadyOwnedError";
  }
}

function unavailableMessage(status: SandboxStatus): string {
  switch (status.kind) {
    case "failed":
      return `Sandbox is unavailable (${status.phase}): ${status.error}`;
    case "review-only":
      return `Sandbox is unavailable on ${status.platform}; Auto must use model review`;
    case "closing":
    case "closed":
      return "Sandbox is shutting down";
    case "new":
    case "initializing":
      return "Sandbox is not ready";
    case "sandboxed":
      return "Sandbox is unavailable";
  }
}
