import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPermissionCommands,
  type PermissionCommandSnapshot,
  type PermissionCommandsHost,
} from "../../src/commands/index.ts";

type RegisteredOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

function makeModel(
  provider: string,
  id: string,
  options: {
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
  } = {},
): Model<string> {
  return {
    id,
    provider,
    name: `${provider}/${id}`,
    api: "test-api",
    baseUrl: "https://invalid.test",
    reasoning: options.reasoning ?? true,
    ...(options.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: options.thinkingLevelMap }),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

interface Harness {
  commands: Map<string, RegisteredOptions>;
  host: PermissionCommandsHost & {
    readSnapshot: ReturnType<typeof vi.fn>;
    setRequestedMode: ReturnType<typeof vi.fn>;
    setReviewerAndAuto: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
  };
  ctx: ExtensionCommandContext;
  ui: {
    select: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    custom: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
  registry: {
    getAvailable: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
  };
  setSnapshot(value: PermissionCommandSnapshot): void;
  setAvailable(models: Model<string>[]): void;
  invoke(name: string, args?: string): Promise<void>;
}

function createHarness(options: { hasUI?: boolean } = {}): Harness {
  let snapshot: PermissionCommandSnapshot = {
    health: "healthy",
    reviewer: { provider: "openai", modelId: "reviewer", thinkingLevel: "high" },
  };
  let available = [makeModel("openai", "reviewer")];

  const commands = new Map<string, RegisteredOptions>();
  const pi = {
    registerCommand: vi.fn((name: string, command: RegisteredOptions) => {
      commands.set(name, command);
    }),
  } as unknown as Pick<ExtensionAPI, "registerCommand">;

  const ui = {
    select: vi.fn(async (): Promise<string | undefined> => undefined),
    confirm: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const registry = {
    getAvailable: vi.fn(() => available),
    find: vi.fn((provider: string, modelId: string) =>
      available.find((model) => model.provider === provider && model.id === modelId),
    ),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "secret" })),
  };
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.hasUI === false ? "print" : "tui",
    ui,
    modelRegistry: registry,
  } as unknown as ExtensionCommandContext;

  const host = {
    readSnapshot: vi.fn(() => snapshot),
    setRequestedMode: vi.fn(async () => undefined),
    setReviewerAndAuto: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  } satisfies PermissionCommandsHost;
  registerPermissionCommands(pi, host);

  return {
    commands,
    host,
    ctx,
    ui,
    registry,
    setSnapshot(value) {
      snapshot = value;
    },
    setAvailable(models) {
      available = models;
    },
    async invoke(name, args = "") {
      const command = commands.get(name);
      if (command === undefined) throw new Error(`missing command ${name}`);
      await command.handler(args, ctx);
    },
  };
}

function expectNoMutation(harness: Harness): void {
  expect(harness.host.setRequestedMode).not.toHaveBeenCalled();
  expect(harness.host.setReviewerAndAuto).not.toHaveBeenCalled();
  expect(harness.host.setEnabled).not.toHaveBeenCalled();
  expect(harness.host.updateStatus).not.toHaveBeenCalled();
}

describe("permission command registration", () => {
  it("registers exactly the three-command surface and useful closed completions", async () => {
    const harness = createHarness();
    expect([...harness.commands.keys()]).toEqual(["perm", "perm-auto-model", "perm-enabled"]);

    const perm = harness.commands.get("perm")!;
    expect(await perm.getArgumentCompletions?.("")).toEqual([
      { value: "auto", label: "auto" },
      { value: "unrestricted", label: "unrestricted" },
    ]);
    expect(await perm.getArgumentCompletions?.("un")).toEqual([
      { value: "unrestricted", label: "unrestricted" },
    ]);
    expect(await perm.getArgumentCompletions?.("ask")).toBeNull();

    const enabled = harness.commands.get("perm-enabled")!;
    expect(await enabled.getArgumentCompletions?.("o")).toEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(harness.commands.get("perm-auto-model")!.getArgumentCompletions).toBeUndefined();
  });
});

describe("/perm", () => {
  it("changes directly to each closed mode and refreshes status", async () => {
    const harness = createHarness();
    await harness.invoke("perm", " auto ");
    await harness.invoke("perm", "unrestricted");

    expect(harness.host.setRequestedMode).toHaveBeenNthCalledWith(1, "auto", harness.ctx);
    expect(harness.host.setRequestedMode).toHaveBeenNthCalledWith(2, "unrestricted", harness.ctx);
    expect(harness.host.updateStatus).toHaveBeenCalledTimes(2);
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith("Permissions: Auto.", "info");
    expect(harness.ui.notify).toHaveBeenCalledWith("Permissions: Unrestricted.", "info");
  });

  it("rejects direct Auto when no reviewer tuple exists", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "healthy", reviewer: null });
    await harness.invoke("perm", "auto");

    expectNoMutation(harness);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/perm-auto-model"),
      "warning",
    );
  });

  it("rejects direct Auto on a fault but still permits Unrestricted", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "fault", error: "schema version 99" });
    await harness.invoke("perm", "auto");
    expect(harness.host.setRequestedMode).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("schema version 99"),
      "warning",
    );

    await harness.invoke("perm", "unrestricted");
    expect(harness.host.setRequestedMode).toHaveBeenCalledExactlyOnceWith("unrestricted", harness.ctx);
  });

  it("uses a two-semantic-choice UI and selects Auto", async () => {
    const harness = createHarness();
    harness.ui.select.mockResolvedValueOnce("Auto");
    await harness.invoke("perm");

    expect(harness.ui.select).toHaveBeenCalledExactlyOnceWith("Permission mode", [
      "Auto",
      "Unrestricted",
    ]);
    expect(harness.host.setRequestedMode).toHaveBeenCalledExactlyOnceWith("auto", harness.ctx);
  });

  it("shows unavailable Auto in the same two-choice UI and cannot select it", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "healthy", reviewer: null });
    harness.ui.select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
    await harness.invoke("perm");

    expect(harness.ui.select).toHaveBeenCalledWith("Permission mode", [
      expect.stringMatching(/^Auto \(unavailable/),
      "Unrestricted",
    ]);
    expectNoMutation(harness);
  });

  it("lets Unrestricted be selected while Auto is unavailable", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "healthy", reviewer: null });
    harness.ui.select.mockResolvedValueOnce("Unrestricted");
    await harness.invoke("perm");

    expect(harness.host.setRequestedMode).toHaveBeenCalledExactlyOnceWith("unrestricted", harness.ctx);
  });

  it("marks Auto unavailable in the selector when settings are faulted", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "fault", error: "truncated JSON" });
    harness.ui.select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
    await harness.invoke("perm");

    expect(harness.ui.select).toHaveBeenCalledWith("Permission mode", [
      expect.stringContaining("repair permissions settings"),
      "Unrestricted",
    ]);
    expectNoMutation(harness);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("truncated JSON"),
      "warning",
    );
  });

  it("treats interactive cancellation as a no-op", async () => {
    const harness = createHarness();
    await harness.invoke("perm");
    expectNoMutation(harness);
    expect(harness.ui.notify).not.toHaveBeenCalled();
  });

  it("contains selector failures without mutation", async () => {
    const harness = createHarness();
    harness.ui.select.mockRejectedValueOnce(new Error("client disconnected"));
    await harness.invoke("perm");
    expectNoMutation(harness);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Could not open permission selection: client disconnected",
      "error",
    );
  });

  it.each(["ask", "Auto", "auto now", "unrestricted now", "on"])(
    "rejects invalid argument %s without opening UI or mutating",
    async (args) => {
      const harness = createHarness();
      await harness.invoke("perm", args);
      expectNoMutation(harness);
      expect(harness.ui.select).not.toHaveBeenCalled();
      expect(harness.ui.notify).toHaveBeenCalledWith(
        "Usage: /perm auto|unrestricted",
        "warning",
      );
    },
  );

  it("does not open UI without dialog support", async () => {
    const harness = createHarness({ hasUI: false });
    await harness.invoke("perm", "   ");
    expectNoMutation(harness);
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Usage: /perm auto|unrestricted",
      "warning",
    );
  });

  it("reports snapshot and mutation failures without mutating status", async () => {
    const harness = createHarness();
    harness.host.readSnapshot.mockRejectedValueOnce(new Error("read failed"));
    await harness.invoke("perm", "auto");
    expectNoMutation(harness);
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Could not read permission settings: read failed",
      "error",
    );

    harness.host.setRequestedMode.mockRejectedValueOnce(new Error("write failed"));
    await harness.invoke("perm", "unrestricted");
    expect(harness.host.updateStatus).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Permission settings were not changed: write failed",
      "error",
    );
  });

  it("does not misreport a completed mutation if only status refresh fails", async () => {
    const harness = createHarness();
    harness.host.updateStatus.mockRejectedValueOnce(new Error("footer gone"));
    await harness.invoke("perm", "unrestricted");

    expect(harness.host.setRequestedMode).toHaveBeenCalledOnce();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Permission settings changed, but status could not be refreshed: footer gone",
      "error",
    );
    expect(harness.ui.notify).toHaveBeenCalledWith("Permissions: Unrestricted.", "info");
  });
});

describe("/perm-auto-model", () => {
  it("commits provider, slash-containing model id, and thinking level as one tuple", async () => {
    const harness = createHarness();
    const model = makeModel("gateway", "org/family/reviewer", {
      thinkingLevelMap: { max: "maximum" },
    });
    harness.setAvailable([model]);
    await harness.invoke("perm-auto-model", "gateway/org/family/reviewer max");

    expect(harness.registry.find).toHaveBeenCalledWith("gateway", "org/family/reviewer");
    expect(harness.registry.getApiKeyAndHeaders).toHaveBeenCalledExactlyOnceWith(model);
    expect(harness.host.setReviewerAndAuto).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "gateway",
        modelId: "org/family/reviewer",
        thinkingLevel: "max",
      },
      harness.ctx,
    );
    expect(harness.host.setRequestedMode).not.toHaveBeenCalled();
    expect(harness.host.updateStatus).toHaveBeenCalledOnce();
  });

  it("accepts level-only changes, including off when the model reports it", async () => {
    const harness = createHarness();
    await harness.invoke("perm-auto-model", "openai/reviewer high");
    await harness.invoke("perm-auto-model", "openai/reviewer off");

    expect(harness.host.setReviewerAndAuto).toHaveBeenNthCalledWith(
      1,
      { provider: "openai", modelId: "reviewer", thinkingLevel: "high" },
      harness.ctx,
    );
    expect(harness.host.setReviewerAndAuto).toHaveBeenNthCalledWith(
      2,
      { provider: "openai", modelId: "reviewer", thinkingLevel: "off" },
      harness.ctx,
    );
  });

  it("accepts off as the sole level on a non-reasoning model", async () => {
    const harness = createHarness();
    harness.setAvailable([makeModel("plain", "model", { reasoning: false })]);
    await harness.invoke("perm-auto-model", "plain/model off");
    expect(harness.host.setReviewerAndAuto).toHaveBeenCalledWith(
      { provider: "plain", modelId: "model", thinkingLevel: "off" },
      harness.ctx,
    );
  });

  it.each([
    "openai/reviewer",
    "openai/reviewer high extra",
    "/reviewer high",
    "openai/ high",
    "reviewer high",
    "openai/reviewer ask",
  ])("rejects incomplete or invalid tuple syntax %s", async (args) => {
    const harness = createHarness();
    await harness.invoke("perm-auto-model", args);
    expectNoMutation(harness);
    expect(harness.registry.find).not.toHaveBeenCalled();
    expect(harness.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Usage: /perm-auto-model provider/model thinkingLevel",
      "warning",
    );
  });

  it("rejects nonexistent and currently unavailable models before auth", async () => {
    const missing = createHarness();
    missing.setAvailable([]);
    await missing.invoke("perm-auto-model", "no/such-model high");
    expectNoMutation(missing);
    expect(missing.ui.notify).toHaveBeenCalledWith(
      "Reviewer model no/such-model does not exist.",
      "warning",
    );
    expect(missing.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();

    const unavailable = createHarness();
    const found = makeModel("local", "offline");
    unavailable.registry.find.mockReturnValueOnce(found);
    unavailable.setAvailable([]);
    await unavailable.invoke("perm-auto-model", "local/offline high");
    expectNoMutation(unavailable);
    expect(unavailable.ui.notify).toHaveBeenCalledWith(
      "Reviewer model local/offline is not available.",
      "warning",
    );
    expect(unavailable.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("rejects an exact but unsupported thinking level without clamping", async () => {
    const harness = createHarness();
    harness.setAvailable([makeModel("openai", "reviewer")]);
    await harness.invoke("perm-auto-model", "openai/reviewer xhigh");

    expectNoMutation(harness);
    expect(harness.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("xhigh is not supported"),
      "warning",
    );
  });

  it("requires usable auth and handles auth resolver failures", async () => {
    const noAuth = createHarness();
    noAuth.registry.getApiKeyAndHeaders.mockResolvedValueOnce({
      ok: false,
      error: "login required",
    });
    await noAuth.invoke("perm-auto-model", "openai/reviewer high");
    expectNoMutation(noAuth);
    expect(noAuth.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("login required"),
      "warning",
    );

    const thrown = createHarness();
    thrown.registry.getApiKeyAndHeaders.mockRejectedValueOnce(new Error("keychain locked"));
    await thrown.invoke("perm-auto-model", "openai/reviewer high");
    expectNoMutation(thrown);
    expect(thrown.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("keychain locked"),
      "error",
    );
  });

  it("interactively selects an exact model then an exact supported level", async () => {
    const harness = createHarness();
    const alpha = makeModel("a-provider", "org/reviewer", {
      thinkingLevelMap: { xhigh: "x-high" },
    });
    const zed = makeModel("z-provider", "reviewer");
    harness.setAvailable([zed, alpha]);
    harness.ui.select
      .mockResolvedValueOnce("a-provider/org/reviewer")
      .mockResolvedValueOnce("xhigh");
    await harness.invoke("perm-auto-model");

    expect(harness.ui.select).toHaveBeenNthCalledWith(1, "Auto reviewer model", [
      "a-provider/org/reviewer",
      "z-provider/reviewer",
    ]);
    expect(harness.ui.select).toHaveBeenNthCalledWith(2, "Auto reviewer thinking level", [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(harness.host.setReviewerAndAuto).toHaveBeenCalledExactlyOnceWith(
      { provider: "a-provider", modelId: "org/reviewer", thinkingLevel: "xhigh" },
      harness.ctx,
    );
  });

  it("never authenticates or mutates after either interactive cancellation", async () => {
    const modelCancelled = createHarness();
    await modelCancelled.invoke("perm-auto-model");
    expectNoMutation(modelCancelled);
    expect(modelCancelled.ui.select).toHaveBeenCalledOnce();
    expect(modelCancelled.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(modelCancelled.ui.notify).not.toHaveBeenCalled();

    const levelCancelled = createHarness();
    levelCancelled.ui.select.mockResolvedValueOnce("openai/reviewer");
    await levelCancelled.invoke("perm-auto-model");
    expectNoMutation(levelCancelled);
    expect(levelCancelled.ui.select).toHaveBeenCalledTimes(2);
    expect(levelCancelled.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(levelCancelled.ui.notify).not.toHaveBeenCalled();
  });

  it("contains either interactive selector failure before authentication or mutation", async () => {
    const modelFailure = createHarness();
    modelFailure.ui.select.mockRejectedValueOnce(new Error("model picker failed"));
    await modelFailure.invoke("perm-auto-model");
    expectNoMutation(modelFailure);
    expect(modelFailure.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();

    const levelFailure = createHarness();
    levelFailure.ui.select
      .mockResolvedValueOnce("openai/reviewer")
      .mockRejectedValueOnce(new Error("level picker failed"));
    await levelFailure.invoke("perm-auto-model");
    expectNoMutation(levelFailure);
    expect(levelFailure.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("rejects selector values not present in the offered exact set", async () => {
    const badModel = createHarness();
    badModel.ui.select.mockResolvedValueOnce("invented/model");
    await badModel.invoke("perm-auto-model");
    expectNoMutation(badModel);

    const badLevel = createHarness();
    badLevel.ui.select
      .mockResolvedValueOnce("openai/reviewer")
      .mockResolvedValueOnce("xhigh");
    await badLevel.invoke("perm-auto-model");
    expectNoMutation(badLevel);
    expect(badLevel.registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("reports no available models and registry failures without mutation", async () => {
    const empty = createHarness();
    empty.setAvailable([]);
    await empty.invoke("perm-auto-model");
    expectNoMutation(empty);
    expect(empty.ui.select).not.toHaveBeenCalled();
    expect(empty.ui.notify).toHaveBeenCalledWith(
      "No available reviewer models were found.",
      "warning",
    );

    const broken = createHarness();
    broken.registry.getAvailable.mockImplementationOnce(() => {
      throw new Error("registry corrupt");
    });
    await broken.invoke("perm-auto-model");
    expectNoMutation(broken);
    expect(broken.ui.notify).toHaveBeenCalledWith(
      "Could not list available reviewer models: registry corrupt",
      "error",
    );
  });

  it("requires arguments instead of opening UI when UI is unavailable", async () => {
    const harness = createHarness({ hasUI: false });
    await harness.invoke("perm-auto-model");
    expectNoMutation(harness);
    expect(harness.ui.select).not.toHaveBeenCalled();
    expect(harness.registry.getAvailable).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Usage: /perm-auto-model provider/model thinkingLevel",
      "warning",
    );
  });

  it("delegates the atomic repair operation even when the global snapshot is faulted", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "fault", error: "bad file" });
    await harness.invoke("perm-auto-model", "openai/reviewer medium");

    expect(harness.host.readSnapshot).not.toHaveBeenCalled();
    expect(harness.host.setReviewerAndAuto).toHaveBeenCalledOnce();
  });

  it("reports host commit failure without a separate mode mutation or status update", async () => {
    const harness = createHarness();
    harness.host.setReviewerAndAuto.mockRejectedValueOnce(new Error("repair failed"));
    await harness.invoke("perm-auto-model", "openai/reviewer medium");

    expect(harness.host.setReviewerAndAuto).toHaveBeenCalledOnce();
    expect(harness.host.setRequestedMode).not.toHaveBeenCalled();
    expect(harness.host.updateStatus).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Permission settings were not changed: repair failed",
      "error",
    );
  });
});

describe("/perm-enabled", () => {
  it("sets on and off globally and refreshes status", async () => {
    const harness = createHarness();
    await harness.invoke("perm-enabled", "on");
    await harness.invoke("perm-enabled", " off ");

    expect(harness.host.setEnabled).toHaveBeenNthCalledWith(1, true, harness.ctx);
    expect(harness.host.setEnabled).toHaveBeenNthCalledWith(2, false, harness.ctx);
    expect(harness.host.updateStatus).toHaveBeenCalledTimes(2);
    expect(harness.ui.notify).toHaveBeenCalledWith("Permissions enabled globally.", "info");
    expect(harness.ui.notify).toHaveBeenCalledWith("Permissions disabled globally.", "info");
  });

  it.each(["", "true", "false", "ON", "on now", "ask"])(
    "rejects invalid argument %j without mutation",
    async (args) => {
      const harness = createHarness();
      await harness.invoke("perm-enabled", args);
      expectNoMutation(harness);
      expect(harness.ui.select).not.toHaveBeenCalled();
      expect(harness.ui.notify).toHaveBeenCalledWith(
        "Usage: /perm-enabled on|off",
        "warning",
      );
    },
  );

  it("delegates on/off even when state is faulted so either can repair it", async () => {
    const harness = createHarness();
    harness.setSnapshot({ health: "fault", error: "wrong version" });
    await harness.invoke("perm-enabled", "off");

    expect(harness.host.readSnapshot).not.toHaveBeenCalled();
    expect(harness.host.setEnabled).toHaveBeenCalledExactlyOnceWith(false, harness.ctx);
  });

  it("contains host failures and performs no status update", async () => {
    const harness = createHarness();
    harness.host.setEnabled.mockRejectedValueOnce(new Error("disk read-only"));
    await harness.invoke("perm-enabled", "on");

    expect(harness.host.updateStatus).not.toHaveBeenCalled();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      "Permission settings were not changed: disk read-only",
      "error",
    );
  });
});

describe("UI boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never calls confirmation, free-form input, or custom dialogs", async () => {
    const harness = createHarness();
    harness.ui.select
      .mockResolvedValueOnce("Auto")
      .mockResolvedValueOnce("openai/reviewer")
      .mockResolvedValueOnce("off");
    await harness.invoke("perm");
    await harness.invoke("perm-auto-model");
    await harness.invoke("perm-enabled", "on");

    expect(harness.ui.confirm).not.toHaveBeenCalled();
    expect(harness.ui.input).not.toHaveBeenCalled();
    expect(harness.ui.custom).not.toHaveBeenCalled();
    expect(harness.ui.setStatus).not.toHaveBeenCalled();
  });
});
