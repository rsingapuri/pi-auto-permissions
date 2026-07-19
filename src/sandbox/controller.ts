import {
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createStrongSandboxConfig } from "./config.ts";
import { createSrtRuntimePort, detectSandboxHost } from "./runtime.ts";
import {
  ProcessSandboxAlreadyOwnedError,
  SandboxUnavailableError,
  type ProductionSandboxControllerOptions,
  type SandboxController,
  type SandboxControllerOptions,
  type SandboxFailurePhase,
  type SandboxStatus,
} from "./types.ts";

const DEFAULT_PROBE_TIMEOUT_SECONDS = 5;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024;

let processOwner: SandboxControllerImpl | "poisoned" | undefined;

export function createSandboxController(options: SandboxControllerOptions): SandboxController {
  return new SandboxControllerImpl(options);
}

/**
 * Claim the one SRT manager owner allowed in a process. The claim is released
 * only after shutdown has drained command leases and completed reset.
 */
export function createProcessSandboxController(options: SandboxControllerOptions): SandboxController {
  // These hosts never touch SRT's singleton, so independent ReviewOnly
  // controllers cannot interfere with one another and need no ownership claim.
  if (!hostMayUseSrt(options.host)) return new SandboxControllerImpl(options);
  if (processOwner === "poisoned") {
    throw new ProcessSandboxAlreadyOwnedError(
      "The process-global sandbox runtime is poisoned after reset failure; restart Pi",
    );
  }
  if (processOwner !== undefined) throw new ProcessSandboxAlreadyOwnedError();

  let controller: SandboxControllerImpl;
  const release = (runtimeReusable: boolean) => {
    if (processOwner === controller) {
      processOwner = runtimeReusable ? undefined : "poisoned";
    }
    options.onClosed?.(runtimeReusable);
  };
  controller = new SandboxControllerImpl({ ...options, onClosed: release });
  processOwner = controller;
  return controller;
}

export function createProductionSandboxController(
  options: ProductionSandboxControllerOptions,
): SandboxController {
  return createProcessSandboxController({
    cwd: options.cwd,
    ...(options.additionalDenyWrite === undefined
      ? {}
      : { additionalDenyWrite: options.additionalDenyWrite }),
    host: detectSandboxHost(),
    runtime: createSrtRuntimePort(),
    localOperations: createLocalBashOperations(),
    shell: getShellConfig().shell,
  });
}

class SandboxControllerImpl implements SandboxController {
  readonly operations: BashOperations;

  private currentStatus: SandboxStatus = Object.freeze({ kind: "new" });
  private readonly cwd: string;
  private readonly options: SandboxControllerOptions;
  private readonly probeTimeoutSeconds: number;
  private startPromise: Promise<SandboxStatus> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownRequested = false;
  private runtimeNeedsReset = false;
  private activeExecutions = 0;
  private drainPromise: Promise<void> | undefined;
  private resolveDrain: (() => void) | undefined;

  constructor(options: SandboxControllerOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.probeTimeoutSeconds = options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS;
    if (!Number.isFinite(this.probeTimeoutSeconds) || this.probeTimeoutSeconds <= 0) {
      throw new TypeError("probeTimeoutSeconds must be a positive finite number");
    }
    this.operations = {
      exec: (command, cwd, executionOptions) =>
        this.executeSandboxed(command, cwd, executionOptions),
    };
  }

  start(): Promise<SandboxStatus> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.currentStatus.kind !== "new") return Promise.resolve(this.status());

    this.setStatus({ kind: "initializing" });
    this.startPromise = this.performStart().catch((error: unknown) =>
      this.fail("initialization", `Unexpected sandbox startup failure: ${errorMessage(error)}`),
    );
    return this.startPromise;
  }

  status(): SandboxStatus {
    return cloneStatus(this.currentStatus);
  }

  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performStart(): Promise<SandboxStatus> {
    const { host, runtime } = this.options;
    if (host.platform !== "darwin" && host.platform !== "linux") {
      this.setStatus({ kind: "review-only", reason: "unsupported-os", platform: host.platform });
      return this.status();
    }
    if (host.platform === "linux" && host.wslVersion === "1") {
      this.setStatus({ kind: "review-only", reason: "wsl1", platform: host.platform });
      return this.status();
    }
    try {
      if (!runtime.isSupportedPlatform()) {
        return this.fail("platform", "Sandbox Runtime does not support this macOS/Linux host");
      }
    } catch (error) {
      return this.fail("platform", errorMessage(error));
    }

    let strongConfig: ReturnType<typeof createStrongSandboxConfig>;
    try {
      strongConfig = createStrongSandboxConfig(this.cwd, {
        ...(this.options.additionalDenyWrite === undefined
          ? {}
          : { additionalDenyWrite: this.options.additionalDenyWrite }),
      });
    } catch (error) {
      return this.fail("configuration", errorMessage(error));
    }

    let dependencies;
    try {
      dependencies = runtime.checkDependencies();
    } catch (error) {
      return this.fail("dependencies", errorMessage(error));
    }
    const fatalWarnings = dependencies.warnings.filter(isFatalDependencyWarning);
    if (dependencies.errors.length > 0 || fatalWarnings.length > 0) {
      return this.fail(
        "dependencies",
        [...dependencies.errors, ...fatalWarnings].join(", ") || "Sandbox dependencies are unavailable",
      );
    }

    // Set before awaiting initialize: a rejected initialization may have
    // partially created SRT's process-global resources.
    this.runtimeNeedsReset = true;
    try {
      await runtime.initialize(strongConfig.config);
    } catch (error) {
      return this.fail("initialization", errorMessage(error));
    }

    try {
      const output = new TailBuffer(MAX_PROBE_OUTPUT_BYTES);
      const result = await this.runWrapped("true", this.cwd, {
        onData: (data) => output.append(data),
        timeout: this.probeTimeoutSeconds,
      });
      if (result.exitCode !== 0) {
        const detail = output.text().trim();
        throw new Error(
          detail.length > 0
            ? `Sandbox probe exited with code ${String(result.exitCode)}: ${detail}`
            : `Sandbox probe exited with code ${String(result.exitCode)}`,
        );
      }
    } catch (error) {
      const probeError = errorMessage(error);
      try {
        await runtime.reset();
        this.runtimeNeedsReset = false;
      } catch (resetError) {
        return this.fail(
          "probe",
          `${probeError}; sandbox reset also failed: ${errorMessage(resetError)}`,
        );
      }
      return this.fail("probe", probeError);
    }

    this.setStatus({ kind: "sandboxed", warnings: Object.freeze([...dependencies.warnings]) });
    return this.status();
  }

  private async executeSandboxed(
    command: string,
    cwd: string,
    executionOptions: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    const release = this.acquireExecution();
    try {
      return await this.runWrapped(command, cwd, executionOptions);
    } finally {
      release();
    }
  }

  private async runWrapped(
    command: string,
    cwd: string,
    executionOptions: Parameters<BashOperations["exec"]>[2],
  ): Promise<{ exitCode: number | null }> {
    let wrappedSuccessfully = false;
    try {
      let wrapped: string;
      try {
        wrapped = await this.options.runtime.wrap(
          command,
          this.options.shell,
          executionOptions.signal,
        );
      } catch (error) {
        // No child was handed to Pi, so this call is safe to fail directly.
        // Mark the process-global sandbox unhealthy so every later lease is
        // denied rather than repeatedly attempting a broken containment path.
        this.fail("runtime", `Sandbox command wrapping failed: ${errorMessage(error)}`);
        throw error;
      }
      wrappedSuccessfully = true;
      return await this.options.localOperations.exec(wrapped, cwd, executionOptions);
    } finally {
      // On Linux, a successful wrap increments SRT's global mount-point lease.
      // A rejected wrap decrements internally, so cleanup must not run then.
      if (wrappedSuccessfully) {
        try {
          this.options.runtime.cleanupAfterCommand();
        } catch (error) {
          this.fail("runtime", `Sandbox command cleanup failed: ${errorMessage(error)}`);
          throw error;
        }
      }
    }
  }

  private acquireExecution(): () => void {
    if (this.shutdownRequested || this.currentStatus.kind !== "sandboxed") {
      throw new SandboxUnavailableError(this.status());
    }
    this.activeExecutions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeExecutions -= 1;
      if (this.activeExecutions === 0) {
        this.resolveDrain?.();
        this.resolveDrain = undefined;
        this.drainPromise = undefined;
      }
    };
  }

  private async performShutdown(): Promise<void> {
    try {
      if (this.startPromise !== undefined) await this.startPromise;
      if (this.currentStatus.kind === "closed") return;
      this.setStatus({ kind: "closing" });
      await this.waitForDrain();
      if (this.runtimeNeedsReset) {
        try {
          await this.options.runtime.reset();
          this.runtimeNeedsReset = false;
        } finally {
          // Status closes either way; the onClosed hook below decides whether
          // process-global ownership is reusable or permanently poisoned.
          this.setStatus({ kind: "closed" });
        }
      } else {
        this.setStatus({ kind: "closed" });
      }
    } finally {
      if (this.currentStatus.kind !== "closed") this.setStatus({ kind: "closed" });
      // If reset failed, SRT may still retain the old initialization promise
      // and policy. Permanently poison ownership rather than ever labeling a
      // later controller with a stale policy as sandboxed.
      this.options.onClosed?.(!this.runtimeNeedsReset);
    }
  }

  private waitForDrain(): Promise<void> {
    if (this.activeExecutions === 0) return Promise.resolve();
    if (this.drainPromise === undefined) {
      this.drainPromise = new Promise<void>((resolveDrain) => {
        this.resolveDrain = resolveDrain;
      });
    }
    return this.drainPromise;
  }

  private fail(phase: SandboxFailurePhase, error: string): SandboxStatus {
    this.setStatus({ kind: "failed", phase, error });
    return this.status();
  }

  private setStatus(status: SandboxStatus): void {
    this.currentStatus = Object.freeze(status);
  }
}

function hostMayUseSrt(host: SandboxControllerOptions["host"]): boolean {
  return (
    (host.platform === "darwin" || host.platform === "linux") &&
    !(host.platform === "linux" && host.wslVersion === "1")
  );
}

function isFatalDependencyWarning(warning: string): boolean {
  return /\bseccomp\b|unix[- ]socket/iu.test(warning);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneStatus(status: SandboxStatus): SandboxStatus {
  if (status.kind === "sandboxed") {
    return { kind: "sandboxed", warnings: [...status.warnings] };
  }
  return { ...status };
}

class TailBuffer {
  private value = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.value = Buffer.concat([this.value, chunk]);
    if (this.value.byteLength > this.maxBytes) {
      this.value = this.value.subarray(this.value.byteLength - this.maxBytes);
    }
  }

  text(): string {
    return this.value.toString("utf8");
  }
}
