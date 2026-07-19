import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_VERSION,
  type GlobalConfig,
  type GlobalState,
  type ReviewerSelection,
} from "../../src/domain.ts";
import {
  GUARDIAN_DENIAL_MESSAGE,
  GUARDIAN_REVIEW_FAILURE_MESSAGE,
  GuardianReviewEngine,
} from "../../src/guardian/index.ts";
import type { DangerousCommandDetector } from "../../src/policy/dangerous-command.ts";
import { StaticPathPolicy } from "../../src/policy/path-policy.ts";
import { PermissionEngine, type PermissionAction } from "../../src/runtime/index.ts";
import { GlobalConfigStore } from "../../src/state/config-store.ts";

const REVIEWER: ReviewerSelection = {
  provider: "test-provider",
  modelId: "reviewer/model",
  thinkingLevel: "high",
};

let base: string;
let workspace: string;
let outside: string;
let temporary: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "pi-permission-engine-")));
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  temporary = path.join(base, "temporary");
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(temporary)]);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

class MemoryStore {
  state: GlobalState;

  constructor(options: { reviewer?: ReviewerSelection | null; enabled?: boolean; fault?: string } = {}) {
    this.state = options.fault
      ? { health: "fault", error: options.fault }
      : {
          health: "valid",
          config: {
            version: CONFIG_VERSION,
            enabled: options.enabled ?? true,
            reviewer: options.reviewer === undefined ? REVIEWER : options.reviewer,
            revision: 1,
          },
        };
  }

  async read(): Promise<GlobalState> {
    return structuredClone(this.state);
  }

  async setEnabled(enabled: boolean): Promise<GlobalConfig> {
    return this.mutate((config) => ({ ...config, enabled }));
  }

  async setReviewer(reviewer: ReviewerSelection | null): Promise<GlobalConfig> {
    return this.mutate((config) => ({ ...config, reviewer }));
  }

  async repair(mutation: { enabled: boolean; reviewer: ReviewerSelection | null }): Promise<GlobalConfig> {
    const revision = this.state.health === "fault" ? 100 : this.state.config.revision + 1;
    const config: GlobalConfig = { version: CONFIG_VERSION, revision, ...mutation };
    this.state = { health: "valid", config };
    return structuredClone(config);
  }

  replaceReviewer(reviewer: ReviewerSelection): void {
    if (this.state.health === "fault") throw new Error("faulted");
    this.state = {
      health: "valid",
      config: { ...this.state.config, reviewer, revision: this.state.config.revision + 1 },
    };
  }

  private mutate(update: (config: GlobalConfig) => GlobalConfig): GlobalConfig {
    if (this.state.health === "fault") throw new Error(this.state.error);
    const next = update(structuredClone(this.state.config));
    next.revision = this.state.config.revision + 1;
    this.state = { health: "valid", config: next };
    return structuredClone(next);
  }
}

interface Harness {
  engine: PermissionEngine;
  store: MemoryStore;
  callModel: ReturnType<typeof vi.fn>;
}

async function harness(options: {
  reviewer?: ReviewerSelection | null;
  enabled?: boolean;
  fault?: string;
  backend?: "sandboxed" | "review-only" | "unavailable";
  verdict?: "allow" | "deny";
  detector?: DangerousCommandDetector | null;
  onModelCall?: () => void | Promise<void>;
} = {}): Promise<Harness> {
  const store = new MemoryStore(options);
  const callModel = vi.fn(async () => {
    await options.onModelCall?.();
    return { text: JSON.stringify({ outcome: options.verdict ?? "allow" }) };
  });
  const guardian = new GuardianReviewEngine({
    callModel,
    maxAttempts: 1,
    retryDelaysMs: [],
  });
  const pathPolicy = await StaticPathPolicy.create({
    cwd: workspace,
    workspaceRoots: [workspace],
    temporaryRoots: [temporary],
  });
  const engine = new PermissionEngine({
    configStore: store,
    pathPolicy,
    guardian,
    sessionId: "session-1",
    dangerousCommandDetector:
      options.detector === undefined ? safeDetector() : options.detector,
  });
  engine.setBackend(options.backend ?? "sandboxed");
  return { engine, store, callModel };
}

function action(overrides: Partial<PermissionAction> = {}): PermissionAction {
  return {
    toolCallId: "call-1",
    turnId: "session-1:turn-1",
    toolName: "custom",
    input: { value: 1 },
    cwd: workspace,
    toolMetadata: { description: "test tool" },
    transcript: [{ kind: "user", text: "Please do the task" }],
    ...overrides,
  };
}

function reviewedShellAction(overrides: Partial<PermissionAction> = {}): PermissionAction {
  return action({
    toolName: "bash",
    input: { command: "echo reviewed", sandbox_permissions: "require_escalated" },
    ...overrides,
  });
}

function safeDetector(): DangerousCommandDetector {
  return { detect: () => undefined, close: vi.fn() };
}

function dangerousDetector(): DangerousCommandDetector {
  return { detect: () => "forced-rm", close: vi.fn() };
}

describe("I1-I4 mode and global-state routing", () => {
  it("uses only local/passthrough routes when globally Off", async () => {
    const { engine, callModel } = await harness({ enabled: false, backend: "sandboxed" });
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo hi" } })))
      .resolves.toEqual({ outcome: "admit", route: "local", reviewed: false });
    await expect(engine.gate(action())).resolves.toEqual({
      outcome: "admit",
      route: "passthrough",
      reviewed: false,
    });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("does not materialize Guardian context while Off or explicitly Unrestricted", async () => {
    const explodingTranscript = () => {
      throw new Error("transcript should stay lazy");
    };
    const off = await harness({ enabled: false });
    await expect(off.engine.gate(action({
      toolName: "third_party",
      transcript: explodingTranscript,
    }))).resolves.toMatchObject({ outcome: "admit", route: "passthrough" });

    const unrestricted = await harness();
    await unrestricted.engine.setRequestedMode("unrestricted");
    await expect(unrestricted.engine.gate(action({
      toolName: "third_party",
      transcript: explodingTranscript,
    }))).resolves.toMatchObject({ outcome: "admit", route: "passthrough" });
    expect(off.callModel).not.toHaveBeenCalled();
    expect(unrestricted.callModel).not.toHaveBeenCalled();
  });

  it("makes Auto unavailable and effectively Unrestricted until the complete reviewer tuple exists", async () => {
    const { engine, callModel } = await harness({ reviewer: null });
    expect((await engine.status()).label).toBe("Unrestricted");
    await expect(engine.setRequestedMode("auto")).rejects.toThrow("model and thinking level");
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo hi" } })))
      .resolves.toMatchObject({ outcome: "admit", route: "local" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("allows explicit Unrestricted even with faulted global state, while Auto faults closed", async () => {
    const first = await harness({ fault: "bad json" });
    await expect(first.engine.gate(action())).resolves.toMatchObject({
      outcome: "deny",
      reason: "configuration_fault",
    });
    await first.engine.setRequestedMode("unrestricted");
    await expect(first.engine.gate(action())).resolves.toMatchObject({ outcome: "admit" });
  });

  it("commits provider/model/thinking together and switches only the invoking session to Auto", async () => {
    const { engine, store } = await harness({ reviewer: null });
    await engine.setRequestedMode("unrestricted");
    await engine.setReviewerAndAuto({ ...REVIEWER, thinkingLevel: "xhigh" });
    expect(engine.sessionState.requestedMode).toBe("auto");
    expect(store.state).toMatchObject({
      health: "valid",
      config: { reviewer: { ...REVIEWER, thinkingLevel: "xhigh" } },
    });
  });

  it("I10 reports counter corruption as Fault, denies Auto gates, and explicitly repairs it", async () => {
    const configPath = path.join(base, "state", "permissions.json");
    const store = new GlobalConfigStore({ configPath });
    const original = await store.setReviewer(REVIEWER);
    const pathPolicy = await StaticPathPolicy.create({
      cwd: workspace,
      workspaceRoots: [workspace],
      temporaryRoots: [temporary],
    });
    const callModel = vi.fn(async () => ({ text: '{"outcome":"allow"}' }));
    const engine = new PermissionEngine({
      configStore: store,
      pathPolicy,
      guardian: new GuardianReviewEngine({ callModel, maxAttempts: 1, retryDelaysMs: [] }),
      sessionId: "real-store-session",
      dangerousCommandDetector: safeDetector(),
    });
    engine.setBackend("sandboxed");

    await writeFile(`${configPath}.revision`, "corrupt-primary", "utf8");
    await expect(engine.status()).resolves.toMatchObject({
      label: "Auto (configuration fault)",
      global: { health: "fault", recoverableConfig: original },
    });
    await expect(engine.gate(action())).resolves.toMatchObject({
      outcome: "deny",
      reason: "configuration_fault",
    });
    expect(callModel).not.toHaveBeenCalled();

    const repaired = await engine.setEnabled(false);
    expect(repaired).toMatchObject({
      enabled: false,
      reviewer: REVIEWER,
      revision: original.revision + 1,
    });
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe(`${repaired.revision}\n`);
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe(
      `${repaired.revision}\n`,
    );
    await expect(engine.status()).resolves.toMatchObject({ label: "Off" });

    await writeFile(`${configPath}.revision.recovery`, "corrupt-recovery", "utf8");
    const replacement = { ...REVIEWER, modelId: "replacement-reviewer" };
    const reviewerRepair = await engine.setReviewerAndAuto(replacement);
    expect(reviewerRepair).toMatchObject({
      enabled: false,
      reviewer: replacement,
      revision: repaired.revision + 1,
    });
    expect(engine.sessionState.requestedMode).toBe("auto");
    await expect(engine.status()).resolves.toMatchObject({ label: "Off" });
  });

  it("I10 repairs simultaneous config/counter faults only through an explicit management mutation", async () => {
    const configPath = path.join(base, "state-pair", "permissions.json");
    const store = new GlobalConfigStore({ configPath });
    const original = await store.setReviewer(REVIEWER);
    const pathPolicy = await StaticPathPolicy.create({
      cwd: workspace,
      workspaceRoots: [workspace],
      temporaryRoots: [temporary],
    });
    const engine = new PermissionEngine({
      configStore: store,
      pathPolicy,
      guardian: new GuardianReviewEngine({
        callModel: async () => ({ text: '{"outcome":"allow"}' }),
        maxAttempts: 1,
        retryDelaysMs: [],
      }),
      sessionId: "paired-fault-session",
      dangerousCommandDetector: safeDetector(),
    });
    engine.setBackend("sandboxed");
    await engine.setRequestedMode("unrestricted");
    await Promise.all([
      writeFile(configPath, "{malformed", "utf8"),
      writeFile(`${configPath}.revision`, "malformed", "utf8"),
    ]);

    await expect(store.setEnabled(false)).rejects.toBeInstanceOf(Error);
    const replacement = { ...REVIEWER, modelId: "replacement", thinkingLevel: "xhigh" as const };
    const repaired = await engine.setReviewerAndAuto(replacement);
    expect(repaired).toEqual({
      version: CONFIG_VERSION,
      enabled: true,
      reviewer: replacement,
      revision: original.revision + 1,
    });
    expect(engine.sessionState.requestedMode).toBe("auto");
    await expect(engine.status()).resolves.toMatchObject({ label: "Auto" });
  });
});

describe("I5 deterministic file routing and custom passthrough", () => {
  it.each(["read", "grep", "find", "ls"])("admits Pi built-in %s without review", async (toolName) => {
    const { engine, callModel } = await harness();
    await expect(engine.gate(action({ toolName, builtInFileTool: true, input: { path: "x" } })))
      .resolves.toMatchObject({ outcome: "admit", reviewed: false });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("admits trusted writes without model review while preserving static hard denials", async () => {
    const { engine, callModel } = await harness();
    await expect(engine.gate(action({
      toolName: "write",
      builtInFileTool: true,
      input: { path: "ordinary.txt", content: "ok" },
    }))).resolves.toMatchObject({ outcome: "admit", reviewed: false });
    await expect(engine.gate(action({
      toolCallId: "call-2",
      toolName: "write",
      builtInFileTool: true,
      input: { path: path.join(outside, "escape"), content: "no" },
    }))).resolves.toMatchObject({ outcome: "admit", reviewed: false });
    await expect(engine.gate(action({
      toolCallId: "call-3",
      toolName: "edit",
      builtInFileTool: true,
      input: { path: ".git/config", edits: [] },
    }))).resolves.toMatchObject({ outcome: "admit", reviewed: false });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("passes through a third-party override even when it uses a standard file-tool name", async () => {
    const { engine, callModel } = await harness();
    await expect(engine.gate(action({ toolName: "read", builtInFileTool: false })))
      .resolves.toMatchObject({ outcome: "admit", reviewed: false });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("returns the invariant denial and creates no admission on shell-review deny", async () => {
    const { engine } = await harness({ verdict: "deny" });
    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "echo safe", sandbox_permissions: "require_escalated" },
    }))).resolves.toEqual({
      outcome: "deny",
      message: GUARDIAN_DENIAL_MESSAGE,
      reason: "review_denied",
      reviewReason: "model_denied",
      interruptTurn: false,
    });
  });

  it("passes through non-shell tools when the supported sandbox is unavailable", async () => {
    const { engine, callModel } = await harness({ backend: "unavailable" });
    await expect(engine.gate(action())).resolves.toMatchObject({
      outcome: "admit",
      route: "passthrough",
      reviewed: false,
    });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("denies extension control-plane paths without consulting the reviewer", async () => {
    const store = new MemoryStore();
    const callModel = vi.fn(async () => ({ text: '{"outcome":"allow"}' }));
    const pathPolicy = await StaticPathPolicy.create({
      cwd: workspace,
      workspaceRoots: [workspace],
      temporaryRoots: [temporary],
      deniedRoots: [path.join(workspace, "permission-state")],
    });
    const engine = new PermissionEngine({
      configStore: store,
      pathPolicy,
      guardian: new GuardianReviewEngine({ callModel, maxAttempts: 1 }),
      sessionId: "state-protection",
      dangerousCommandDetector: safeDetector(),
    });
    engine.setBackend("sandboxed");
    await expect(engine.gate(action({
      toolName: "write",
      builtInFileTool: true,
      input: { path: "permission-state/state.json", content: "{}" },
    }))).resolves.toMatchObject({ outcome: "deny", reason: "invalid_action" });
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe("I6-I10 shell backend exhaustion", () => {
  it("runs ordinary healthy commands only through the sandbox", async () => {
    const { engine, callModel } = await harness({ backend: "sandboxed" });
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo safe" } })))
      .resolves.toEqual({ outcome: "admit", route: "sandboxed", reviewed: false });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("reviews dangerous commands and then keeps them inside the sandbox", async () => {
    const { engine, callModel } = await harness({
      backend: "sandboxed",
      detector: dangerousDetector(),
    });
    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "rm -rf build" },
    }))).resolves.toEqual({
      outcome: "admit",
      route: "sandboxed",
      reviewed: true,
    });
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("reviews explicit escalation before local execution", async () => {
    const { engine, callModel } = await harness({
      backend: "sandboxed",
      detector: safeDetector(),
    });
    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "echo safe", sandbox_permissions: "require_escalated" },
    }))).resolves.toEqual({
      outcome: "admit",
      route: "local",
      reviewed: true,
    });
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("reviews every shell command on a positively unsupported ReviewOnly host", async () => {
    const { engine, callModel } = await harness({ backend: "review-only" });
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo safe" } })))
      .resolves.toMatchObject({ outcome: "admit", route: "local", reviewed: true });
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("denies every Auto shell command after a supported-host sandbox failure", async () => {
    const { engine, callModel } = await harness({ backend: "unavailable" });
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo safe" } })))
      .resolves.toEqual({
        outcome: "deny",
        message: GUARDIAN_REVIEW_FAILURE_MESSAGE,
        reason: "sandbox_unavailable",
        interruptTurn: false,
      });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("routes parser uncertainty to review instead of silently skipping Codex rules", async () => {
    const { engine, callModel } = await harness({ detector: null });
    await expect(engine.gate(action({ toolName: "bash", input: { command: "echo safe" } })))
      .resolves.toMatchObject({ outcome: "admit", route: "sandboxed", reviewed: true });
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed shell permission input", async () => {
    const { engine, callModel } = await harness();
    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "echo safe", sandbox_permissions: "anything" },
    }))).resolves.toMatchObject({ outcome: "deny", reason: "invalid_action" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("I16 counts pre-review denials and resets them on a statically admitted Auto action", async () => {
    const { engine, callModel } = await harness();
    const malformed = () => engine.gate(action({ toolName: "bash", input: { command: 42 } }));

    await expect(malformed()).resolves.toMatchObject({ outcome: "deny", interruptTurn: false });
    await expect(malformed()).resolves.toMatchObject({ outcome: "deny", interruptTurn: false });
    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "echo safe" },
    }))).resolves.toMatchObject({ outcome: "admit", route: "sandboxed" });
    await expect(malformed()).resolves.toMatchObject({ outcome: "deny", interruptTurn: false });
    await expect(malformed()).resolves.toMatchObject({ outcome: "deny", interruptTurn: false });
    await expect(malformed()).resolves.toMatchObject({ outcome: "deny", interruptTurn: true });
    expect(callModel).not.toHaveBeenCalled();
  });
});

describe("I8/I14 exact stale binding", () => {
  it("binds the selected thinking level into the model request", async () => {
    const { engine, callModel } = await harness();
    await engine.gate(reviewedShellAction());
    expect(callModel.mock.calls[0]?.[0]).toMatchObject({
      provider: REVIEWER.provider,
      modelId: REVIEWER.modelId,
      reasoning: "high",
    });
  });

  it("denies when only the reviewer thinking level changes during review", async () => {
    let store!: MemoryStore;
    const built = await harness({
      onModelCall: () => store.replaceReviewer({ ...REVIEWER, thinkingLevel: "xhigh" }),
    });
    store = built.store;
    await expect(built.engine.gate(reviewedShellAction())).resolves.toMatchObject({
      outcome: "deny",
      reason: "review_denied",
    });
  });

  it("denies argument mutation, mode ABA, backend change, and session death", async () => {
    for (const mutation of ["arguments", "mode-aba", "backend", "shutdown"] as const) {
      const input = { command: "echo reviewed", sandbox_permissions: "require_escalated" };
      let engine!: PermissionEngine;
      const built = await harness({
        onModelCall: async () => {
          if (mutation === "arguments") input.command = "echo mutated";
          if (mutation === "mode-aba") {
            await engine.setRequestedMode("unrestricted");
            await engine.setRequestedMode("auto");
          }
          if (mutation === "backend") engine.setBackend("review-only");
          if (mutation === "shutdown") engine.shutdown();
        },
      });
      engine = built.engine;
      await expect(engine.gate(reviewedShellAction({ input }))).resolves.toMatchObject({ outcome: "deny" });
    }
  });

  it("I5/I14 denies static routes after session shutdown", async () => {
    const { engine, callModel } = await harness();
    engine.shutdown();

    await expect(engine.gate(action({
      toolName: "bash",
      input: { command: "echo never" },
    }))).resolves.toMatchObject({ outcome: "deny", reason: "stale_binding" });
    await expect(engine.gate(action({
      toolName: "read",
      builtInFileTool: true,
      input: { path: "ordinary.txt" },
    }))).resolves.toMatchObject({ outcome: "deny", reason: "stale_binding" });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("I5/I14 rechecks lifecycle after asynchronous static classification", async () => {
    let releaseClassification: (() => void) | undefined;
    let classificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      classificationStarted = resolve;
    });
    const guardian = new GuardianReviewEngine({
      callModel: vi.fn(async () => ({ text: '{"outcome":"allow"}' })),
      maxAttempts: 1,
      retryDelaysMs: [],
    });
    const engine = new PermissionEngine({
      configStore: new MemoryStore(),
      pathPolicy: {
        classify: async () => {
          classificationStarted();
          await new Promise<void>((resolve) => {
            releaseClassification = resolve;
          });
          return { disposition: "admit", reason: "injected delayed admission" };
        },
      },
      guardian,
      sessionId: "delayed-session",
      dangerousCommandDetector: safeDetector(),
    });
    engine.setBackend("sandboxed");

    const pending = engine.gate(action({
      toolName: "write",
      builtInFileTool: true,
      input: { path: "ordinary.txt", content: "never" },
    }));
    await started;
    engine.shutdown();
    releaseClassification?.();
    await expect(pending).resolves.toMatchObject({ outcome: "deny", reason: "stale_binding" });
  });

  it("I16 shell denial breakers never block a delayed non-shell static action", async () => {
    let releaseClassification: (() => void) | undefined;
    let classificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      classificationStarted = resolve;
    });
    const guardian = new GuardianReviewEngine({
      callModel: vi.fn(async () => ({ text: '{"outcome":"allow"}' })),
      maxAttempts: 1,
      retryDelaysMs: [],
    });
    const engine = new PermissionEngine({
      configStore: new MemoryStore(),
      pathPolicy: {
        classify: async () => {
          classificationStarted();
          await new Promise<void>((resolve) => {
            releaseClassification = resolve;
          });
          return { disposition: "admit", reason: "injected delayed admission" };
        },
      },
      guardian,
      sessionId: "breaker-race",
      dangerousCommandDetector: safeDetector(),
    });
    engine.setBackend("sandboxed");
    const sharedTurn = "breaker-race:turn";

    const pending = engine.gate(action({
      turnId: sharedTurn,
      toolName: "write",
      builtInFileTool: true,
      input: { path: "ordinary.txt", content: "never" },
    }));
    await started;

    const malformed = (toolCallId: string) => engine.gate(action({
      toolCallId,
      turnId: sharedTurn,
      toolName: "bash",
      input: { command: 42 },
    }));
    const denials = await Promise.all([
      malformed("deny-1"),
      malformed("deny-2"),
      malformed("deny-3"),
    ]);
    expect(
      denials.filter(
        (decision) => decision.outcome === "deny" && decision.interruptTurn,
      ),
    ).toHaveLength(1);

    releaseClassification?.();
    await expect(pending).resolves.toMatchObject({
      outcome: "admit",
      route: "passthrough",
      reviewed: false,
    });
    expect(guardian.circuitBreakerSnapshot(sharedTurn)).toMatchObject({
      consecutiveDenials: 3,
      interruptTurn: true,
    });
  });
});

describe("I17 honest status", () => {
  it.each([
    ["sandboxed", "Auto"],
    ["review-only", "Auto (review-only)"],
    ["unavailable", "Auto (sandbox unavailable)"],
  ] as const)("reports backend %s as %s", async (backend, label) => {
    const { engine } = await harness({ backend });
    expect((await engine.status()).label).toBe(label);
  });
});
