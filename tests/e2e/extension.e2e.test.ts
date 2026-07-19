import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
  type BashOperations,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionUIContext,
  type ModelRegistry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPermissionExtension } from "../../src/extension.ts";
import {
  GUARDIAN_DENIAL_MESSAGE,
  GUARDIAN_OPERATION_ABORTED_MESSAGE,
  GUARDIAN_REVIEW_FAILURE_MESSAGE,
  GuardianReviewEngine,
  type GuardianModelRequest,
} from "../../src/guardian/index.ts";
import type { DangerousCommandDetector } from "../../src/policy/dangerous-command.ts";
import {
  ProcessSandboxAlreadyOwnedError,
  type SandboxController,
  type SandboxStatus,
} from "../../src/sandbox/index.ts";
import { GlobalConfigStore } from "../../src/state/index.ts";
import { SANDBOX_RETRY_GUIDELINE } from "../../src/tools/bash.ts";

const REVIEW_MODEL: Model<string> = {
  id: "judge/one",
  name: "Judge One",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  reasoning: true,
  thinkingLevelMap: { high: "high", xhigh: "xhigh" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
};

let root: string;
let workspace: string;
let agentDir: string;
const live: TestRuntime[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-auto-permissions-e2e-"));
  workspace = path.join(root, "workspace");
  agentDir = path.join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
});

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.shutdown();
  await rm(root, { recursive: true, force: true });
});

interface TestEnvironment {
  verdict: "allow" | "deny";
  guardianCalls: unknown[];
  localCommands: string[];
  sandboxCommands: string[];
  backend: SandboxStatus;
}

interface UiSpies {
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  editor: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
}

class TestRuntime {
  constructor(
    readonly runner: ExtensionRunner,
    readonly sessionManager: SessionManager,
    readonly env: TestEnvironment,
    readonly sandbox: FakeSandboxController,
    readonly ui: UiSpies,
    readonly abort: ReturnType<typeof vi.fn>,
  ) {}

  async start(reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup") {
    await this.runner.emit({ type: "session_start", reason });
  }

  async shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit") {
    if (!this.runner.hasHandlers("session_shutdown")) return;
    await this.runner.emit({ type: "session_shutdown", reason });
  }

  async command(name: string, args: string): Promise<void> {
    const command = this.runner.getCommand(name);
    if (command === undefined) throw new Error(`missing command ${name}`);
    await command.handler(args, this.runner.createCommandContext());
  }

  async bash(params: {
    command: string;
    timeout?: number;
    sandbox_permissions?: "use_default" | "require_escalated";
  }, signal?: AbortSignal): Promise<unknown> {
    const definition = this.runner.getToolDefinition("bash");
    if (definition === undefined) throw new Error("guarded bash was not registered");
    return definition.execute(
      `bash-${this.env.localCommands.length}-${this.env.sandboxCommands.length}`,
      params,
      signal,
      undefined,
      this.runner.createContext(),
    );
  }

  async tool(toolName: string, input: Record<string, unknown>, toolCallId: string): Promise<unknown> {
    return this.runner.emitToolCall({ type: "tool_call", toolCallId, toolName, input });
  }

  status(): string | undefined {
    const calls = this.ui.setStatus.mock.calls;
    return calls.at(-1)?.[1] as string | undefined;
  }
}

async function createRuntime(options: {
  backend?: SandboxStatus;
  sandboxCreationFailure?: boolean;
  pathPolicyFailure?: boolean;
  sessionManager?: SessionManager;
  tools?: ToolInfo[];
  uiMode?: "tui" | "print";
  guardianCall?: (
    request: GuardianModelRequest,
    environment: TestEnvironment,
    signal: AbortSignal,
  ) => Promise<{ text: string }>;
} = {}): Promise<TestRuntime> {
  const env: TestEnvironment = {
    verdict: "allow",
    guardianCalls: [],
    localCommands: [],
    sandboxCommands: [],
    backend: options.backend ?? { kind: "sandboxed", warnings: [] },
  };
  const localOperations = recordingOperations(env.localCommands);
  const sandbox = new FakeSandboxController(env.backend, recordingOperations(env.sandboxCommands));
  const extension = createPermissionExtension({
    getAgentDir: () => agentDir,
    createSandbox: () => {
      if (options.sandboxCreationFailure === true) {
        throw new ProcessSandboxAlreadyOwnedError();
      }
      return sandbox;
    },
    createDangerousCommandDetector: async () => detector(),
    createGuardian: () =>
      new GuardianReviewEngine({
        maxAttempts: 1,
        retryDelaysMs: [],
        callModel: async (request, signal) => {
          env.guardianCalls.push(request);
          if (options.guardianCall !== undefined) {
            return options.guardianCall(request, env, signal);
          }
          return { text: JSON.stringify({ outcome: env.verdict }) };
        },
      }),
    transcript: () => [{ kind: "user", text: "perform the requested task" }],
    createBashDefinition: (cwd, operations) =>
      createBashToolDefinition(cwd, { operations: operations ?? localOperations }),
    ...(options.pathPolicyFailure === true
      ? {
          createPathPolicy: async () => {
            throw new Error("injected path policy failure");
          },
        }
      : {}),
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    extensionFactories: [extension],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);

  const sessionManager = options.sessionManager ?? SessionManager.inMemory(workspace);
  const modelRegistry = reviewerRegistry();
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    workspace,
    sessionManager,
    modelRegistry,
  );
  const abort = vi.fn();
  const tools = options.tools ?? toolInfo();
  const actions: ExtensionActions = {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      sessionManager.appendSessionInfo(name);
    },
    getSessionName: () => sessionManager.getSessionName(),
    setLabel: vi.fn(),
    getActiveTools: () => tools.map((tool) => tool.name),
    getAllTools: () => tools,
    setActiveTools: vi.fn(),
    refreshTools: vi.fn(),
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: vi.fn(),
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort,
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "test system",
    getSystemPromptOptions: () => ({ cwd: workspace }),
  };
  runner.bindCore(actions, contextActions);
  runner.bindCommandContext();

  const ui = uiSpies();
  const baseUi = runner.getUIContext();
  runner.setUIContext(
    {
      ...baseUi,
      select: ui.select,
      confirm: ui.confirm,
      input: ui.input,
      editor: ui.editor,
      notify: ui.notify,
      setStatus: ui.setStatus,
    } as ExtensionUIContext,
    options.uiMode ?? "tui",
  );

  const runtime = new TestRuntime(runner, sessionManager, env, sandbox, ui, abort);
  live.push(runtime);
  return runtime;
}

function reviewerRegistry(): ModelRegistry {
  return {
    find: (provider: string, modelId: string) =>
      provider === REVIEW_MODEL.provider && modelId === REVIEW_MODEL.id ? REVIEW_MODEL : undefined,
    getAvailable: () => [REVIEW_MODEL],
    getApiKeyAndHeaders: async () => ({ ok: true as const }),
  } as unknown as ModelRegistry;
}

function toolInfo(): ToolInfo[] {
  const builtin = (name: string): ToolInfo => ({
    name,
    description: `${name} builtin`,
    parameters: { type: "object" } as ToolInfo["parameters"],
    sourceInfo: {
      path: `<builtin:${name}>`,
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  });
  return [
    ...["read", "grep", "find", "ls", "write", "edit"].map(builtin),
    {
      name: "third_party",
      description: "trusted custom implementation",
      parameters: { type: "object" } as ToolInfo["parameters"],
      sourceInfo: {
        path: "/extension/third-party.ts",
        source: "third-party",
        scope: "user",
        origin: "top-level",
      },
    },
  ];
}

function recordingOperations(commands: string[]): BashOperations {
  return {
    exec: async (command, _cwd, options) => {
      commands.push(command);
      options.onData(Buffer.from(`ran:${command}`));
      return { exitCode: 0 };
    },
  };
}

function detector(): DangerousCommandDetector {
  return {
    detect: (command) => (/(?:^|\s)rm\s+[^\n]*-\w*f/iu.test(command) ? "forced-rm" : undefined),
    close: vi.fn(),
  };
}

class FakeSandboxController implements SandboxController {
  private shutdownErrorOnce: Error | undefined;

  constructor(
    private current: SandboxStatus,
    readonly operations: BashOperations,
  ) {}

  async start(): Promise<SandboxStatus> {
    return this.status();
  }

  status(): SandboxStatus {
    return this.current.kind === "sandboxed"
      ? { kind: "sandboxed", warnings: [...this.current.warnings] }
      : { ...this.current };
  }

  failRuntime(error = "sandbox runtime failed"): void {
    this.current = { kind: "failed", phase: "runtime", error };
  }

  failNextShutdown(error = "injected shutdown failure"): void {
    this.shutdownErrorOnce = new Error(error);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownErrorOnce !== undefined) {
      const error = this.shutdownErrorOnce;
      this.shutdownErrorOnce = undefined;
      throw error;
    }
    this.current = { kind: "closed" };
  }
}

function uiSpies(): UiSpies {
  return {
    select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => undefined),
    editor: vi.fn(async () => undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
}

function stateStore(): GlobalConfigStore {
  return new GlobalConfigStore({
    configPath: path.join(agentDir, "pi-auto-permissions", "state.json"),
  });
}

async function configureReviewer(thinkingLevel: "high" | "xhigh" = "high"): Promise<void> {
  await stateStore().setReviewer({
    provider: REVIEW_MODEL.provider,
    modelId: REVIEW_MODEL.id,
    thinkingLevel,
  });
}

function expectNoActionDialogs(runtime: TestRuntime): void {
  expect(runtime.ui.select).not.toHaveBeenCalled();
  expect(runtime.ui.confirm).not.toHaveBeenCalled();
  expect(runtime.ui.input).not.toHaveBeenCalled();
  expect(runtime.ui.editor).not.toHaveBeenCalled();
}

describe("black-box Pi extension lifecycle", () => {
  it("loads the shipped TypeScript entrypoint through Pi's real extension loader", async () => {
    const extensionPath = fileURLToPath(new URL("../../src/extension.ts", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect(loaded.extensions[0]?.commands.has("perm-auto-model")).toBe(true);
    expect(loaded.extensions[0]?.tools.has("bash")).toBe(true);
  });

  it("I2 starts first-run sessions effectively Unrestricted until model plus thinking are selected", async () => {
    const runtime = await createRuntime();
    await runtime.start();

    expect(runtime.ui.notify).toHaveBeenCalledWith(
      "Permissions are enabled, but Auto is unavailable because no reviewer model is configured. Run /perm-auto-model to select a reviewer and thinking level.",
      "warning",
    );
    expect(runtime.status()).toBe("Permissions: Unrestricted");

    await runtime.bash({ command: "echo first-run" });
    expect(runtime.env.localCommands).toEqual(["echo first-run"]);
    expect(runtime.env.sandboxCommands).toEqual([]);
    expect(runtime.env.guardianCalls).toEqual([]);

    await runtime.command("perm", "auto");
    expect(runtime.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unavailable"), "warning");
    expectNoActionDialogs(runtime);
  });

  it("I2 commits exact provider/model/thinking and immediately enters Auto", async () => {
    const runtime = await createRuntime();
    await runtime.start();
    await runtime.command("perm-auto-model", "test-provider/judge/one xhigh");

    expect(runtime.status()).toBe("Permissions: Auto");
    expect(await stateStore().read()).toMatchObject({
      health: "valid",
      config: {
        reviewer: {
          provider: "test-provider",
          modelId: "judge/one",
          thinkingLevel: "xhigh",
        },
      },
    });

    await runtime.bash({
      command: "echo reviewed",
      sandbox_permissions: "require_escalated",
    });
    expect(runtime.env.guardianCalls.at(-1)).toMatchObject({ reasoning: "xhigh" });
  });

  it("I2 activates remembered default-Auto sessions but preserves explicit Unrestricted", async () => {
    const selector = await createRuntime();
    const defaultSibling = await createRuntime();
    const explicitSibling = await createRuntime();
    await Promise.all([
      selector.start(),
      defaultSibling.start(),
      explicitSibling.start(),
    ]);
    await explicitSibling.command("perm", "unrestricted");

    await selector.command("perm-auto-model", "test-provider/judge/one high");
    await defaultSibling.bash({ command: "echo remembered-auto" });
    await explicitSibling.bash({ command: "echo explicit-unrestricted" });

    expect(selector.status()).toBe("Permissions: Auto");
    expect(defaultSibling.status()).toBe("Permissions: Auto");
    expect(defaultSibling.env.sandboxCommands).toEqual(["echo remembered-auto"]);
    expect(defaultSibling.env.localCommands).toEqual([]);
    expect(explicitSibling.status()).toBe("Permissions: Unrestricted");
    expect(explicitSibling.env.localCommands).toEqual(["echo explicit-unrestricted"]);
    expect(explicitSibling.env.sandboxCommands).toEqual([]);
  });

  it("I3 reload alone restores Unrestricted; every fresh reason and descendant depth starts Auto", async () => {
    await configureReviewer();
    const session = SessionManager.inMemory(workspace, { id: "parent" });
    const parent = await createRuntime({ sessionManager: session });
    await parent.start();
    await parent.command("perm", "unrestricted");
    expect(parent.status()).toBe("Permissions: Unrestricted");
    await parent.shutdown("reload");

    const reloaded = await createRuntime({ sessionManager: session });
    await reloaded.start("reload");
    expect(reloaded.status()).toBe("Permissions: Unrestricted");

    for (const reason of ["startup", "resume", "fork", "new"] as const) {
      const child = await createRuntime({
        sessionManager: SessionManager.inMemory(workspace, { id: `child-${reason}` }),
      });
      await child.start(reason);
      expect(child.status()).toBe("Permissions: Auto");
    }

    const child = await createRuntime({
      sessionManager: SessionManager.inMemory(workspace, { id: "child" }),
    });
    await child.start("fork");
    await child.command("perm", "unrestricted");
    expect(child.status()).toBe("Permissions: Unrestricted");

    const grandchild = await createRuntime({
      sessionManager: SessionManager.inMemory(workspace, { id: "grandchild" }),
    });
    await grandchild.start("fork");
    expect(grandchild.status()).toBe("Permissions: Auto");
  });

  it("I3/I10 starts the replacement session fail-closed even if prior cleanup rejects", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();
    runtime.sandbox.failNextShutdown();

    await runtime.start("new");
    expect(runtime.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Previous permission session cleanup failed"),
      "warning",
    );
    expect(runtime.status()).toBe("Permissions: Auto");
    await runtime.bash({ command: "echo replacement" });
    expect(runtime.env.sandboxCommands).toEqual(["echo replacement"]);
    expect(runtime.env.localCommands).toEqual([]);
  });

  it("I4 observes global Off/on from already-running sibling sessions", async () => {
    await configureReviewer();
    const first = await createRuntime();
    const sibling = await createRuntime();
    await first.start();
    await sibling.start();

    await first.command("perm-enabled", "off");
    await sibling.bash({ command: "echo off" });
    expect(sibling.status()).toBe("Permissions: Off");
    expect(sibling.env.localCommands).toEqual(["echo off"]);
    expect(sibling.env.sandboxCommands).toEqual([]);

    const newcomer = await createRuntime();
    await newcomer.start();
    expect(newcomer.status()).toBe("Permissions: Off");
    await newcomer.bash({ command: "echo new-off" });
    expect(newcomer.env.localCommands).toEqual(["echo new-off"]);
    expect(newcomer.env.sandboxCommands).toEqual([]);

    await first.command("perm-enabled", "on");
    await sibling.bash({ command: "echo on" });
    expect(sibling.status()).toBe("Permissions: Auto");
    expect(sibling.env.sandboxCommands).toEqual(["echo on"]);
    await newcomer.bash({ command: "echo new-on" });
    expect(newcomer.status()).toBe("Permissions: Auto");
    expect(newcomer.env.sandboxCommands).toEqual(["echo new-on"]);
  });
});

describe("black-box Pi action routing", () => {
  it("I7 executes ordinary Auto bash exactly once and only in the sandbox", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();
    await runtime.bash({ command: "printf safe" });
    expect(runtime.env.sandboxCommands).toEqual(["printf safe"]);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.guardianCalls).toEqual([]);
    expectNoActionDialogs(runtime);
  });

  it("I5 routes standard file tools deterministically without Guardian review", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();

    const outsideTarget = path.join(path.parse(workspace).root, "pi-auto-permissions-e2e-outside");
    const controlPlane = path.join(agentDir, "pi-auto-permissions", "state.json");
    for (const toolName of ["read", "grep", "find", "ls"]) {
      expect(await runtime.tool(toolName, { path: controlPlane }, `readonly-${toolName}`)).toBeUndefined();
    }
    for (const toolName of ["write", "edit"]) {
      expect(
        await runtime.tool(
          toolName,
          { path: path.join(workspace, `${toolName}.txt`), content: "safe" },
          `workspace-${toolName}`,
        ),
      ).toBeUndefined();
    }
    expect(runtime.env.guardianCalls).toEqual([]);

    runtime.env.verdict = "deny";
    for (const [route, target] of [
      ["protected", path.join(workspace, ".git", "config")],
      ["outside", outsideTarget],
    ] as const) {
      for (const toolName of ["write", "edit"]) {
        expect(
          await runtime.tool(toolName, { path: target, content: "unsafe" }, `${route}-${toolName}`),
        ).toBeUndefined();
      }
    }
    expect(await runtime.tool("write", { content: "missing path" }, "unresolved-write")).toBeUndefined();
    expect(runtime.env.guardianCalls).toEqual([]);

    for (const toolName of ["write", "edit"]) {
      expect(
        await runtime.tool(
          toolName,
          { path: controlPlane, content: "self elevation" },
          `control-${toolName}`,
        ),
      ).toEqual({ block: true, reason: GUARDIAN_DENIAL_MESSAGE });
    }
    expect(runtime.env.guardianCalls).toEqual([]);
    expectNoActionDialogs(runtime);
  });

  it("I5 statically routes trusted SDK-backed standard file tools", async () => {
    await configureReviewer();
    const sdkTools = toolInfo().map((tool) =>
      ["read", "grep", "find", "ls", "write", "edit"].includes(tool.name)
        ? {
            ...tool,
            sourceInfo: {
              path: `<sdk:${tool.name}>`,
              source: "sdk",
              scope: "temporary" as const,
              origin: "top-level" as const,
            },
          }
        : tool,
    );
    const runtime = await createRuntime({ tools: sdkTools });
    await runtime.start();
    runtime.env.verdict = "deny";

    expect(await runtime.tool("read", { path: "/tmp/evidence.log" }, "sdk-read")).toBeUndefined();
    expect(
      await runtime.tool(
        "edit",
        { path: path.join(workspace, "sdk-edit.txt"), edits: [] },
        "sdk-edit",
      ),
    ).toBeUndefined();
    expect(runtime.env.guardianCalls).toEqual([]);
  });

  it("passes reads through without consulting unavailable permission runtime state", async () => {
    const runtime = await createRuntime();

    expect(await runtime.tool("read", { path: "ordinary.txt" }, "pre-start-read")).toBeUndefined();
    expect(runtime.ui.notify).not.toHaveBeenCalled();
    expect(runtime.env.guardianCalls).toEqual([]);
  });

  it("I5 passes through a custom tool even when it uses a standard file-tool name", async () => {
    await configureReviewer();
    const spoofedTools = toolInfo().map((tool) =>
      tool.name === "write"
        ? {
            ...tool,
            description: "custom tool pretending to be write",
            sourceInfo: {
              path: "/extension/spoof-write.ts",
              source: "third-party" as const,
              scope: "user" as const,
              origin: "top-level" as const,
            },
          }
        : tool,
    );
    const runtime = await createRuntime({ tools: spoofedTools });
    await runtime.start();
    runtime.env.verdict = "deny";

    expect(
      await runtime.tool(
        "write",
        { path: path.join(workspace, "would-be-static.txt"), content: "spoofed" },
        "spoofed-write",
      ),
    ).toBeUndefined();
    expect(runtime.env.guardianCalls).toEqual([]);
  });

  it("instructs the agent to re-run important sandbox failures with escalation", async () => {
    const runtime = await createRuntime();
    const bash = runtime.runner.getToolDefinition("bash");

    expect(bash?.promptGuidelines).toEqual([SANDBOX_RETRY_GUIDELINE]);
  });

  it("I1/I4 applies the Off, Unrestricted, and Auto routing matrix to bash and custom tools", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();

    await runtime.bash({ command: "echo auto" });
    expect(await runtime.tool("third_party", { mode: "auto" }, "custom-auto")).toBeUndefined();
    expect(runtime.env.sandboxCommands).toEqual(["echo auto"]);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.guardianCalls).toEqual([]);

    await runtime.command("perm", "unrestricted");
    await runtime.bash({ command: "echo unrestricted" });
    await runtime.bash({ command: "rm -rf unrestricted-output" });
    expect(
      await runtime.tool("third_party", { mode: "unrestricted" }, "custom-unrestricted"),
    ).toBeUndefined();
    expect(
      await runtime.tool(
        "write",
        { path: path.join(agentDir, "pi-auto-permissions", "state.json") },
        "control-unrestricted",
      ),
    ).toBeUndefined();
    expect(runtime.env.localCommands).toEqual([
      "echo unrestricted",
      "rm -rf unrestricted-output",
    ]);
    expect(runtime.env.guardianCalls).toEqual([]);

    await runtime.command("perm", "auto");
    await runtime.command("perm-enabled", "off");
    await runtime.bash({ command: "echo off" });
    await runtime.bash({
      command: "rm -rf off-output",
      sandbox_permissions: "require_escalated",
    });
    expect(await runtime.tool("third_party", { mode: "off" }, "custom-off")).toBeUndefined();
    expect(
      await runtime.tool(
        "edit",
        { path: path.join(agentDir, "pi-auto-permissions", "state.json") },
        "control-off",
      ),
    ).toBeUndefined();
    expect(runtime.env.localCommands).toEqual([
      "echo unrestricted",
      "rm -rf unrestricted-output",
      "echo off",
      "rm -rf off-output",
    ]);
    expect(runtime.env.guardianCalls).toEqual([]);

    await runtime.command("perm-enabled", "on");
    await runtime.bash({ command: "echo auto-again" });
    expect(await runtime.tool("third_party", { mode: "auto-again" }, "custom-auto-again")).toBeUndefined();
    expect(runtime.env.sandboxCommands).toEqual(["echo auto", "echo auto-again"]);
    expect(runtime.env.guardianCalls).toEqual([]);
  });

  it("I5 reviews pinned dangerous bash without an explicit escalation request", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();

    await runtime.bash({ command: "rm -rf generated" });
    expect(runtime.env.guardianCalls).toHaveLength(1);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.sandboxCommands).toEqual(["rm -rf generated"]);

    runtime.env.verdict = "deny";
    await expect(runtime.bash({ command: "rm -f precious.txt" })).rejects.toThrow(
      GUARDIAN_DENIAL_MESSAGE,
    );
    expect(runtime.env.guardianCalls).toHaveLength(2);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.sandboxCommands).toEqual(["rm -rf generated"]);
    expect(runtime.ui.notify).toHaveBeenCalledWith(
      "Permission denied: bash action was not executed. Guardian result: model_denied.",
      "warning",
    );
  });

  it("I5/I9 approved escalation runs local once; denial runs zero times with fixed no-recourse error", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();

    await runtime.bash({
      command: "rm -rf build",
      sandbox_permissions: "require_escalated",
    });
    expect(runtime.env.localCommands).toEqual(["rm -rf build"]);
    expect(runtime.env.sandboxCommands).toEqual([]);

    runtime.env.verdict = "deny";
    await expect(runtime.bash({
      command: "rm -rf other",
      sandbox_permissions: "require_escalated",
    })).rejects.toThrow(GUARDIAN_DENIAL_MESSAGE);
    expect(runtime.env.localCommands).toEqual(["rm -rf build"]);
    expectNoActionDialogs(runtime);
  });

  it("I5 passes trusted third-party tool calls through without Guardian review", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();
    runtime.env.verdict = "deny";

    const result = await runtime.runner.emitToolCall({
      type: "tool_call",
      toolCallId: "third-party",
      toolName: "third_party",
      input: { target: "one" },
    });
    expect(result).toBeUndefined();
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.ui.notify).not.toHaveBeenCalledWith(
      "Permission denied: third_party action was not executed.",
      "warning",
    );
    expectNoActionDialogs(runtime);
  });

  it("I12 statically denies direct writes to the extension control plane", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();
    const result = await runtime.runner.emitToolCall({
      type: "tool_call",
      toolCallId: "self-elevation",
      toolName: "write",
      input: {
        path: path.join(agentDir, "pi-auto-permissions", "state.json"),
        content: '{"enabled":false}',
      },
    });
    expect(result).toEqual({ block: true, reason: GUARDIAN_DENIAL_MESSAGE });
    expect(runtime.env.guardianCalls).toEqual([]);
  });

  it("I10/I12 fails closed for direct mutations when path policy initialization fails", async () => {
    await configureReviewer();
    const runtime = await createRuntime({ pathPolicyFailure: true });
    await runtime.start();

    expect(await runtime.tool("read", { path: "ordinary.txt" }, "fallback-read")).toBeUndefined();
    expect(
      await runtime.tool(
        "write",
        { path: path.join(workspace, "ordinary.txt"), content: "never" },
        "fallback-write",
      ),
    ).toEqual({ block: true, reason: GUARDIAN_DENIAL_MESSAGE });
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Auto write/edit actions will be denied"),
      "error",
    );
  });

  it("I6 reviews every shell command on unsupported ReviewOnly and executes only allowed actions", async () => {
    await configureReviewer();
    const runtime = await createRuntime({
      backend: { kind: "review-only", reason: "unsupported-os", platform: "win32" },
    });
    await runtime.start();
    expect(runtime.status()).toBe("Permissions: Auto (review-only)");
    await runtime.bash({ command: "echo reviewed" });
    expect(runtime.env.guardianCalls).toHaveLength(1);
    expect(runtime.env.localCommands).toEqual(["echo reviewed"]);
    expect(runtime.env.sandboxCommands).toEqual([]);

    runtime.env.verdict = "deny";
    await expect(runtime.bash({ command: "echo denied" })).rejects.toThrow(
      GUARDIAN_DENIAL_MESSAGE,
    );
    expect(runtime.env.guardianCalls).toHaveLength(2);
    expect(runtime.env.localCommands).toEqual(["echo reviewed"]);
    expect(runtime.env.sandboxCommands).toEqual([]);
    expectNoActionDialogs(runtime);
  });

  it("I10/I17 observes a supported sandbox runtime failure and fail-closes all later Auto bash", async () => {
    await configureReviewer();
    const runtime = await createRuntime();
    await runtime.start();
    await runtime.bash({ command: "echo before-failure" });
    expect(runtime.env.sandboxCommands).toEqual(["echo before-failure"]);

    runtime.sandbox.failRuntime("sandbox cleanup failed");
    await expect(runtime.bash({ command: "echo after-failure" })).rejects.toThrow(
      GUARDIAN_REVIEW_FAILURE_MESSAGE,
    );
    expect(runtime.status()).toBe("Permissions: Auto (sandbox unavailable)");
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.sandboxCommands).toEqual(["echo before-failure"]);

    await expect(
      runtime.bash({ command: "echo escalated", sandbox_permissions: "require_escalated" }),
    ).rejects.toThrow(GUARDIAN_REVIEW_FAILURE_MESSAGE);
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.env.localCommands).toEqual([]);
  });

  it("I10/I17 supported sandbox failure denies every Auto shell command without model or process", async () => {
    await configureReviewer();
    const runtime = await createRuntime({
      backend: { kind: "failed", phase: "probe", error: "containment unavailable" },
    });
    await runtime.start();
    expect(runtime.status()).toBe("Permissions: Auto (sandbox unavailable)");
    await expect(runtime.bash({ command: "echo never" })).rejects.toThrow(
      GUARDIAN_REVIEW_FAILURE_MESSAGE,
    );
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.sandboxCommands).toEqual([]);
  });

  it("I10/I17 fails closed when another supported session owns SRT's process singleton", async () => {
    await configureReviewer();
    const runtime = await createRuntime({ sandboxCreationFailure: true });
    await runtime.start();

    expect(runtime.status()).toBe("Permissions: Auto (sandbox unavailable)");
    await expect(runtime.bash({ command: "echo never" })).rejects.toThrow(
      GUARDIAN_REVIEW_FAILURE_MESSAGE,
    );
    expect(runtime.env.guardianCalls).toEqual([]);
    expect(runtime.env.localCommands).toEqual([]);
    expect(runtime.env.sandboxCommands).toEqual([]);
    expect(runtime.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Auto shell commands will be denied"),
      "error",
    );
  });

  it("reports user-cancelled shell review as an abort, not a permission denial", async () => {
    const runtime = await createRuntime({
      guardianCall: async () => new Promise(() => undefined),
    });
    await configureReviewer();
    await runtime.start();
    const controller = new AbortController();
    const operation = runtime.bash(
      { command: "rm -rf generated", sandbox_permissions: "require_escalated" },
      controller.signal,
    );
    await vi.waitFor(() => expect(runtime.env.guardianCalls).toHaveLength(1));
    controller.abort();

    await expect(operation).rejects.toThrow(GUARDIAN_OPERATION_ABORTED_MESSAGE);
    expect(runtime.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Permission denied"),
      expect.anything(),
    );
    expect(runtime.env.localCommands).toEqual([]);
  });

  it("I11 has no action-dialog path in noninteractive print mode and safer calls can continue", async () => {
    await configureReviewer();
    const runtime = await createRuntime({ uiMode: "print" });
    await runtime.start();
    runtime.env.verdict = "deny";
    await expect(
      runtime.bash({
        command: "echo reviewed",
        sandbox_permissions: "require_escalated",
      }),
    ).rejects.toThrow(GUARDIAN_DENIAL_MESSAGE);

    runtime.env.verdict = "allow";
    await runtime.bash({ command: "echo safer" });
    expect(runtime.env.sandboxCommands).toEqual(["echo safer"]);
    expectNoActionDialogs(runtime);
  });

  it("I8/I14 rereads global reviewer thinking and rejects an approval captured under the stale tuple", async () => {
    await configureReviewer("high");
    let markReviewStarted: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    let releaseReview: (() => void) | undefined;
    const reviewRelease = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    let reviewCount = 0;
    const runtime = await createRuntime({
      guardianCall: async (_request, environment) => {
        reviewCount += 1;
        if (reviewCount === 1) {
          markReviewStarted?.();
          await reviewRelease;
        }
        return { text: JSON.stringify({ outcome: environment.verdict }) };
      },
    });
    const sibling = await createRuntime();
    await runtime.start();
    await sibling.start();

    const staleApproval = runtime.bash({
      command: "echo captured-under-high",
      sandbox_permissions: "require_escalated",
    });
    await reviewStarted;
    expect(runtime.env.guardianCalls.at(-1)).toMatchObject({ reasoning: "high" });

    await sibling.command("perm-auto-model", "test-provider/judge/one xhigh");
    releaseReview?.();
    await expect(staleApproval).rejects.toThrow(GUARDIAN_REVIEW_FAILURE_MESSAGE);

    await runtime.bash({
      command: "echo fresh-under-xhigh",
      sandbox_permissions: "require_escalated",
    });
    expect(runtime.env.guardianCalls.at(-1)).toMatchObject({ reasoning: "xhigh" });
  });

  it("I5/I11 delivers a denied action to the real Pi agent loop as an error tool result", async () => {
    await configureReviewer();
    const contexts: Context[] = [];
    const localCommands: string[] = [];
    const sandboxCommands: string[] = [];
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("e2e-main", {
      baseUrl: "https://example.invalid",
      apiKey: "test-key",
      api: "e2e-api",
      models: [
        {
          id: "main",
          name: "E2E Main",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10_000,
          maxTokens: 2_000,
        },
      ],
      streamSimple(selected, context) {
        contexts.push(context);
        const hasResult = context.messages.some((message) => message.role === "toolResult");
        const reason = hasResult ? "stop" : "toolUse";
        const message = assistantMessage(
          selected,
          hasResult
            ? [{ type: "text", text: "I received the denial and continued safely." }]
            : [
                {
                  type: "toolCall",
                  id: "danger-call",
                  name: "bash",
                  arguments: {
                    command: "rm -rf dangerous",
                    sandbox_permissions: "require_escalated",
                  },
                },
              ],
          reason,
        );
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason, message });
        stream.end();
        return stream;
      },
    });
    await modelRuntime.refresh({ allowNetwork: false });
    const mainModel = modelRuntime.getModel("e2e-main", "main");
    if (mainModel === undefined) throw new Error("main E2E model missing");

    const sandbox = new FakeSandboxController(
      { kind: "sandboxed", warnings: [] },
      recordingOperations(sandboxCommands),
    );
    const extension = createPermissionExtension({
      getAgentDir: () => agentDir,
      createSandbox: () => sandbox,
      createDangerousCommandDetector: async () => detector(),
      createGuardian: () =>
        new GuardianReviewEngine({
          maxAttempts: 1,
          retryDelaysMs: [],
          callModel: async () => ({ text: '{"outcome":"deny"}' }),
        }),
      transcript: () => [{ kind: "user", text: "do the action" }],
      createBashDefinition: (cwd, operations) =>
        createBashToolDefinition(cwd, {
          operations: operations ?? recordingOperations(localCommands),
        }),
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      modelRuntime,
      model: mainModel,
      tools: ["bash"],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("Try the risky action, then continue if it is denied.");
      expect(localCommands).toEqual([]);
      expect(sandboxCommands).toEqual([]);
      const toolResult = session.messages.find((message) => message.role === "toolResult");
      expect(toolResult).toMatchObject({
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: GUARDIAN_DENIAL_MESSAGE }],
      });
      expect(contexts.at(-1)?.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: GUARDIAN_DENIAL_MESSAGE }],
        }),
      );
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "I received the denial and continued safely." }],
      });
    } finally {
      session.dispose();
      await sandbox.shutdown();
    }
  });

  it("I12 never dispatches model-authored slash-like text as a permission command", async () => {
    await configureReviewer();
    const localCommands: string[] = [];
    const sandboxCommands: string[] = [];
    let modelCall = 0;
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("e2e-slash", {
      baseUrl: "https://example.invalid",
      apiKey: "test-key",
      api: "e2e-slash-api",
      models: [
        {
          id: "main",
          name: "E2E Slash Main",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 10_000,
          maxTokens: 2_000,
        },
      ],
      streamSimple(selected) {
        modelCall += 1;
        let content: AssistantMessage["content"];
        let reason: "stop" | "toolUse";
        if (modelCall === 1) {
          content = [{ type: "text", text: "/perm unrestricted" }];
          reason = "stop";
        } else if (modelCall === 2) {
          content = [
            {
              type: "toolCall",
              id: "bash-after-slash-text",
              name: "bash",
              arguments: { command: "echo still-auto" },
            },
          ];
          reason = "toolUse";
        } else {
          content = [{ type: "text", text: "The command stayed in Auto." }];
          reason = "stop";
        }
        const message = assistantMessage(selected, content, reason);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason, message });
        stream.end();
        return stream;
      },
    });
    await modelRuntime.refresh({ allowNetwork: false });
    const mainModel = modelRuntime.getModel("e2e-slash", "main");
    if (mainModel === undefined) throw new Error("slash E2E model missing");

    const sandbox = new FakeSandboxController(
      { kind: "sandboxed", warnings: [] },
      recordingOperations(sandboxCommands),
    );
    const extension = createPermissionExtension({
      getAgentDir: () => agentDir,
      createSandbox: () => sandbox,
      createDangerousCommandDetector: async () => detector(),
      createGuardian: () =>
        new GuardianReviewEngine({
          maxAttempts: 1,
          retryDelaysMs: [],
          callModel: async () => ({ text: '{"outcome":"allow"}' }),
        }),
      transcript: () => [{ kind: "user", text: "remain in Auto" }],
      createBashDefinition: (cwd, operations) =>
        createBashToolDefinition(cwd, {
          operations: operations ?? recordingOperations(localCommands),
        }),
    });
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workspace),
      modelRuntime,
      model: mainModel,
      tools: ["bash"],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("Print slash-like text, but do not execute it.");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "/perm unrestricted" }],
      });

      await session.prompt("Now run the ordinary shell command.");
      expect(session.messages.find((message) => message.role === "toolResult")).toMatchObject({
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "ran:echo still-auto" }],
      });
      expect({ sandboxCommands, localCommands }).toEqual({
        sandboxCommands: ["echo still-auto"],
        localCommands: [],
      });
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "The command stayed in Auto." }],
      });
    } finally {
      session.dispose();
      await sandbox.shutdown();
    }
  });
});

function assistantMessage(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}
