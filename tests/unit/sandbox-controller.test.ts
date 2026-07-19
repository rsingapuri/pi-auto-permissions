import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProcessSandboxAlreadyOwnedError,
  SandboxUnavailableError,
  backendForSandboxStatus,
  createProcessSandboxController,
  createSandboxController,
  createStrongSandboxConfig,
  type SandboxController,
  type SandboxControllerOptions,
  type SandboxDependencyReport,
  type SandboxRuntimePort,
} from "../../src/sandbox/index.ts";

const temporaryPaths: string[] = [];
const controllers: SandboxController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0).reverse()) {
    await controller.shutdown().catch(() => undefined);
  }
  for (const path of temporaryPaths.splice(0).reverse()) rmSync(path, { force: true, recursive: true });
});

describe("strong sandbox configuration", () => {
  it("I7 validates a fixed workspace+temp, deny-network policy and protects resolved Git data", () => {
    const root = temporaryDirectory();
    const workspace = directory(join(root, "workspace"));
    const home = directory(join(root, "home"));
    const temporary = directory(join(root, "temporary"));
    const systemTemporary = directory(join(root, "system-temporary"));
    const gitDirectory = directory(join(root, "linked-git"));
    const commonDirectory = directory(join(root, "common-git"));
    const durableState = directory(join(workspace, "global-state"));
    const durableStateLink = join(workspace, "global-state-link");
    symlinkSync(durableState, durableStateLink, "dir");
    writeFileSync(join(workspace, ".git"), "gitdir: ../linked-git\n", "utf8");
    writeFileSync(join(gitDirectory, "commondir"), "../common-git\n", "utf8");

    const built = createStrongSandboxConfig(workspace, {
      homeDirectory: home,
      temporaryDirectory: temporary,
      systemTemporaryDirectory: systemTemporary,
      additionalDenyWrite: [durableStateLink],
    });

    expect(built.workspace).toBe(realpathSync(workspace));
    expect(built.config.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    });
    expect(built.config.filesystem.denyRead).toEqual([]);
    expect(built.config.filesystem.allowWrite).toEqual(
      expect.arrayContaining([
        realpathSync(workspace),
        realpathSync(temporary),
        realpathSync(systemTemporary),
      ]),
    );
    expect(built.protectedPaths).toEqual(
      expect.arrayContaining([
        resolve(built.workspace, ".git"),
        resolve(built.workspace, ".agents"),
        resolve(built.workspace, ".codex"),
        resolve(built.workspace, ".pi"),
        realpathSync(gitDirectory),
        realpathSync(commonDirectory),
        resolve(realpathSync(home), ".npm/_logs"),
        resolve(realpathSync(home), ".claude/debug"),
        resolve(durableStateLink),
        realpathSync(durableState),
      ]),
    );
    expect(built.config).toMatchObject({
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowPty: false,
    });
  });

  it("rejects a filesystem-root workspace", () => {
    expect(() => createStrongSandboxConfig(resolve("/"))).toThrow(/filesystem root/u);
  });

  it("rejects a filesystem-root temporary write grant", () => {
    const root = temporaryDirectory();
    const workspace = directory(join(root, "workspace"));
    const home = directory(join(root, "home"));
    expect(() =>
      createStrongSandboxConfig(workspace, {
        homeDirectory: home,
        temporaryDirectory: resolve("/"),
        systemTemporaryDirectory: join(root, "absent-system-temp"),
      }),
    ).toThrow(/filesystem root writable/u);
  });

  it("rejects relative extension-owned deny-write paths", () => {
    const workspace = directory(join(temporaryDirectory(), "workspace"));
    expect(() =>
      createStrongSandboxConfig(workspace, { additionalDenyWrite: ["relative-state"] }),
    ).toThrow(/must be absolute/u);
  });
});

describe("platform and startup routing", () => {
  it("I17 selects ReviewOnly on unsupported operating systems without touching SRT", async () => {
    const fixture = createFixture({ platform: "freebsd" });
    const status = await fixture.controller.start();

    expect(status).toEqual({ kind: "review-only", reason: "unsupported-os", platform: "freebsd" });
    expect(backendForSandboxStatus(status)).toBe("review-only");
    expect(fixture.runtime.calls).toEqual([]);
    await expect(run(fixture.controller, "echo should-not-run")).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(fixture.local.commands).toEqual([]);
  });

  it("I17 selects ReviewOnly on WSL1 without probing dependencies", async () => {
    const fixture = createFixture({ platform: "linux", wslVersion: "1" });
    const status = await fixture.controller.start();

    expect(status).toEqual({ kind: "review-only", reason: "wsl1", platform: "linux" });
    expect(fixture.runtime.calls).toEqual([]);
  });

  it("I10 fails closed when SRT rejects an otherwise supported macOS/Linux host", async () => {
    const fixture = createFixture({ platform: "darwin" });
    fixture.runtime.supported = false;

    await expect(fixture.controller.start()).resolves.toMatchObject({
      kind: "failed",
      phase: "platform",
    });
    await expect(run(fixture.controller, "echo denied")).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(fixture.local.commands).toEqual([]);
  });

  it("I10 treats dependency errors as Failed, never ReviewOnly", async () => {
    const fixture = createFixture({ platform: "linux" });
    fixture.runtime.dependencies = { errors: ["bubblewrap missing"], warnings: [] };

    await expect(fixture.controller.start()).resolves.toEqual({
      kind: "failed",
      phase: "dependencies",
      error: "bubblewrap missing",
    });
    expect(fixture.runtime.initializedConfigs).toHaveLength(0);
    expect(fixture.local.commands).toHaveLength(0);
  });

  it("I7 treats missing seccomp/Unix-socket enforcement as a fatal dependency", async () => {
    const fixture = createFixture({ platform: "linux" });
    fixture.runtime.dependencies = {
      errors: [],
      warnings: ["seccomp not available - unix socket access not restricted"],
    };

    await expect(fixture.controller.start()).resolves.toMatchObject({
      kind: "failed",
      phase: "dependencies",
    });
    expect(fixture.runtime.initializedConfigs).toHaveLength(0);
  });

  it("retains non-fatal dependency warnings in honest Sandboxed status", async () => {
    const fixture = createFixture({ platform: "linux" });
    fixture.runtime.dependencies = { errors: [], warnings: ["diagnostic warning"] };

    const status = await fixture.controller.start();
    expect(status).toEqual({ kind: "sandboxed", warnings: ["diagnostic warning"] });
    expect(backendForSandboxStatus(status)).toBe("sandboxed");
  });

  it("I10 records initialization failure and denies execution until shutdown resets", async () => {
    const fixture = createFixture({ platform: "darwin" });
    fixture.runtime.initializeError = new Error("proxy bind failed");

    await expect(fixture.controller.start()).resolves.toEqual({
      kind: "failed",
      phase: "initialization",
      error: "proxy bind failed",
    });
    expect(fixture.runtime.wrappedCommands).toEqual([]);
    expect(fixture.runtime.resetCount).toBe(0);

    await fixture.controller.shutdown();
    expect(fixture.runtime.resetCount).toBe(1);
  });

  it("I10 fails startup when the real execution probe exits nonzero and resets immediately", async () => {
    const fixture = createFixture({ platform: "darwin" });
    fixture.local.execute = async (command, _cwd, options) => {
      options.onData(Buffer.from("probe failed", "utf8"));
      fixture.local.commands.push(command);
      return { exitCode: 9 };
    };

    await expect(fixture.controller.start()).resolves.toEqual({
      kind: "failed",
      phase: "probe",
      error: "Sandbox probe exited with code 9: probe failed",
    });
    expect(fixture.runtime.wrappedCommands).toEqual(["true"]);
    expect(fixture.runtime.cleanupCount).toBe(1);
    expect(fixture.runtime.resetCount).toBe(1);
  });

  it("runs concurrent start calls through one initialization and one real probe", async () => {
    const fixture = createFixture({ platform: "darwin" });
    const initialization = deferred<void>();
    fixture.runtime.initializeGate = initialization.promise;

    const first = fixture.controller.start();
    const second = fixture.controller.start();
    expect(first).toBe(second);
    expect(fixture.runtime.initializedConfigs).toHaveLength(1);

    initialization.resolve();
    await expect(first).resolves.toMatchObject({ kind: "sandboxed" });
    expect(fixture.runtime.wrappedCommands).toEqual(["true"]);
    expect(fixture.local.commands).toEqual(["wrapped:true"]);
  });
});

describe("execution and lifecycle", () => {
  it("I7 initializes with parsed fixed config, probes true, and executes a command once sandboxed", async () => {
    const fixture = createFixture({ platform: "darwin" });
    await expect(fixture.controller.start()).resolves.toMatchObject({ kind: "sandboxed" });

    expect(fixture.runtime.initializedConfigs).toHaveLength(1);
    expect(fixture.runtime.initializedConfigs[0]?.network).toMatchObject({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
    fixture.runtime.clearExecutionLog();
    fixture.local.commands.length = 0;

    await expect(run(fixture.controller, "printf exact-command")).resolves.toEqual({ exitCode: 0 });
    expect(fixture.runtime.wrappedCommands).toEqual(["printf exact-command"]);
    expect(fixture.local.commands).toEqual(["wrapped:printf exact-command"]);
    expect(fixture.runtime.cleanupCount).toBe(1);
  });

  it("I9 never invokes the executor or cleanup when wrapping rejects", async () => {
    const fixture = createFixture({ platform: "darwin" });
    await fixture.controller.start();
    fixture.runtime.clearExecutionLog();
    fixture.local.commands.length = 0;
    fixture.runtime.wrapErrorFor = "blocked-before-spawn";

    await expect(run(fixture.controller, "blocked-before-spawn")).rejects.toThrow("wrap failed");
    expect(fixture.runtime.wrappedCommands).toEqual(["blocked-before-spawn"]);
    expect(fixture.local.commands).toEqual([]);
    expect(fixture.runtime.cleanupCount).toBe(0);
    expect(fixture.controller.status()).toMatchObject({ kind: "failed", phase: "runtime" });
    await expect(run(fixture.controller, "later-command")).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(fixture.runtime.wrappedCommands).toEqual(["blocked-before-spawn"]);
  });

  it("I9 cleans exactly once and never retries when execution may have started", async () => {
    const fixture = createFixture({ platform: "darwin" });
    await fixture.controller.start();
    fixture.runtime.clearExecutionLog();
    fixture.local.commands.length = 0;
    fixture.local.execute = async (command) => {
      fixture.local.commands.push(command);
      throw new Error("ambiguous process failure");
    };

    await expect(run(fixture.controller, "may-have-started")).rejects.toThrow(
      "ambiguous process failure",
    );
    expect(fixture.runtime.wrappedCommands).toEqual(["may-have-started"]);
    expect(fixture.local.commands).toEqual(["wrapped:may-have-started"]);
    expect(fixture.runtime.cleanupCount).toBe(1);
  });

  it("shutdown blocks new leases, drains an in-flight command, then resets", async () => {
    const fixture = createFixture({ platform: "darwin" });
    await fixture.controller.start();
    fixture.runtime.clearExecutionLog();
    const execution = deferred<{ exitCode: number | null }>();
    fixture.local.execute = async (command) => {
      fixture.local.commands.push(command);
      return execution.promise;
    };

    const running = run(fixture.controller, "hold-open");
    await Promise.resolve();
    const shutdown = fixture.controller.shutdown();

    await expect(run(fixture.controller, "late-command")).rejects.toBeInstanceOf(
      SandboxUnavailableError,
    );
    expect(fixture.runtime.resetCount).toBe(0);

    execution.resolve({ exitCode: 0 });
    await expect(running).resolves.toEqual({ exitCode: 0 });
    await shutdown;
    expect(fixture.runtime.cleanupCount).toBe(1);
    expect(fixture.runtime.resetCount).toBe(1);
    expect(fixture.controller.status()).toEqual({ kind: "closed" });
  });

  it("serializes ownership of SRT's process-global singleton until shutdown completes", async () => {
    const first = createFixture({ platform: "darwin" }, true);
    await first.controller.start();

    expect(() => createFixture({ platform: "darwin" }, true)).toThrow(
      ProcessSandboxAlreadyOwnedError,
    );

    await first.controller.shutdown();
    const second = createFixture({ platform: "darwin" }, true);
    await expect(second.controller.start()).resolves.toMatchObject({ kind: "sandboxed" });
  });

  it("does not serialize positively unsupported ReviewOnly controllers", async () => {
    const first = createFixture({ platform: "freebsd" }, true);
    const second = createFixture({ platform: "freebsd" }, true);
    await expect(Promise.all([first.controller.start(), second.controller.start()])).resolves.toEqual([
      { kind: "review-only", reason: "unsupported-os", platform: "freebsd" },
      { kind: "review-only", reason: "unsupported-os", platform: "freebsd" },
    ]);
  });

  it("poisons process ownership after reset failure so stale policy can never be reused", async () => {
    const first = createFixture({ platform: "darwin" }, true);
    await first.controller.start();
    first.runtime.resetError = new Error("reset failed");

    await expect(first.controller.shutdown()).rejects.toThrow("reset failed");
    expect(first.controller.status()).toEqual({ kind: "closed" });

    expect(() => createFixture({ platform: "darwin" }, true)).toThrow(/poisoned.*restart/iu);
  });
});

interface Fixture {
  controller: SandboxController;
  runtime: FakeRuntime;
  local: FakeLocalOperations;
  cwd: string;
}

function createFixture(host: SandboxControllerOptions["host"], processGlobal = false): Fixture {
  const cwd = directory(join(temporaryDirectory(), "workspace"));
  const runtime = new FakeRuntime();
  const local = new FakeLocalOperations();
  const options: SandboxControllerOptions = {
    cwd,
    host,
    runtime,
    localOperations: local.operations,
    shell: "/bin/bash",
  };
  const controller = processGlobal
    ? createProcessSandboxController(options)
    : createSandboxController(options);
  controllers.push(controller);
  return { controller, runtime, local, cwd };
}

class FakeRuntime implements SandboxRuntimePort {
  supported = true;
  dependencies: SandboxDependencyReport = { errors: [], warnings: [] };
  initializeError: Error | undefined;
  initializeGate: Promise<void> | undefined;
  resetError: Error | undefined;
  wrapErrorFor: string | undefined;
  readonly calls: string[] = [];
  readonly initializedConfigs: SandboxRuntimeConfig[] = [];
  readonly wrappedCommands: string[] = [];
  cleanupCount = 0;
  resetCount = 0;

  isSupportedPlatform(): boolean {
    this.calls.push("isSupportedPlatform");
    return this.supported;
  }

  checkDependencies(): SandboxDependencyReport {
    this.calls.push("checkDependencies");
    return this.dependencies;
  }

  async initialize(config: SandboxRuntimeConfig): Promise<void> {
    this.calls.push("initialize");
    this.initializedConfigs.push(config);
    if (this.initializeError !== undefined) throw this.initializeError;
    await this.initializeGate;
  }

  async wrap(command: string): Promise<string> {
    this.calls.push("wrap");
    this.wrappedCommands.push(command);
    if (this.wrapErrorFor === command) throw new Error("wrap failed");
    return `wrapped:${command}`;
  }

  cleanupAfterCommand(): void {
    this.calls.push("cleanupAfterCommand");
    this.cleanupCount += 1;
  }

  async reset(): Promise<void> {
    this.calls.push("reset");
    this.resetCount += 1;
    if (this.resetError !== undefined) throw this.resetError;
  }

  clearExecutionLog(): void {
    this.wrappedCommands.length = 0;
    this.cleanupCount = 0;
  }
}

class FakeLocalOperations {
  readonly commands: string[] = [];
  execute: BashOperations["exec"] = async (command) => {
    this.commands.push(command);
    return { exitCode: 0 };
  };
  readonly operations: BashOperations = {
    exec: (command, cwd, options) => this.execute(command, cwd, options),
  };
}

function run(controller: SandboxController, command: string): Promise<{ exitCode: number | null }> {
  return controller.operations.exec(command, process.cwd(), { onData: () => undefined });
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-sandbox-unit-"));
  temporaryPaths.push(path);
  return path;
}

function directory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
