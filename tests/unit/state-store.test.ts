import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG } from "../../src/domain.ts";
import type { ReviewerSelection } from "../../src/domain.ts";
import {
  ConfigFaultError,
  GlobalConfigStore,
  parseGlobalConfig,
  readGlobalConfig,
  serializeGlobalConfig,
} from "../../src/state/config-store.ts";
import type {
  ConfigFileSystem,
  DurableHandle,
  ExclusiveLock,
} from "../../src/state/config-store.ts";

const REVIEWER: ReviewerSelection = {
  provider: "provider-a",
  modelId: "model-a",
  thinkingLevel: "medium",
};

const DIRECT_LOCK: ExclusiveLock = {
  run: async <T>(_path: string, operation: () => Promise<T>): Promise<T> => operation(),
};

const temporaryDirectories: string[] = [];

async function configFixture(): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-auto-permissions-state-"));
  temporaryDirectories.push(directory);
  return { directory, configPath: join(directory, "private", "permissions.json") };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("I2/I13 durable global state", () => {
  it("treats a missing file as the safe first-run state without creating it", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });

    await expect(store.read()).resolves.toEqual({
      health: "missing",
      config: DEFAULT_GLOBAL_CONFIG,
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes a private, parseable file and increments only committed mutations", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });

    const disabled = await store.setEnabled(false);
    expect(disabled).toEqual({ version: 1, enabled: false, reviewer: null, revision: 1 });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${configPath}.revision`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${configPath}.revision.recovery`)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(configPath))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(disabled);

    await expect(store.setEnabled(false)).resolves.toEqual(disabled);
    await expect(store.read()).resolves.toEqual({ health: "valid", config: disabled });
  });

  it("treats provider, model ID, and thinking level as one atomic revisioned tuple", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });

    const originalInput = { ...REVIEWER };
    const firstPromise = store.setReviewer(originalInput);
    originalInput.provider = "mutated-after-call";
    const first = await firstPromise;
    expect(first.reviewer).toEqual(REVIEWER);
    expect(first.revision).toBe(1);

    const provider = await store.setReviewer({ ...REVIEWER, provider: "provider-b" });
    const model = await store.setReviewer({ ...provider.reviewer!, modelId: "model-b" });
    const thinking = await store.setReviewer({ ...model.reviewer!, thinkingLevel: "max" });
    expect([provider.revision, model.revision, thinking.revision]).toEqual([2, 3, 4]);
    expect(thinking.reviewer).toEqual({
      provider: "provider-b",
      modelId: "model-b",
      thinkingLevel: "max",
    });

    thinking.reviewer!.provider = "caller-mutation";
    const reread = await store.read();
    expect(reread.health).toBe("valid");
    if (reread.health !== "fault") expect(reread.config.reviewer?.provider).toBe("provider-b");
  });

  it("serializes concurrent processes/stores and rereads under the lock", async () => {
    const { configPath } = await configFixture();
    const firstProcess = new GlobalConfigStore({ configPath });
    const secondProcess = new GlobalConfigStore({ configPath });

    await Promise.all([
      firstProcess.setEnabled(false),
      secondProcess.setReviewer(REVIEWER),
    ]);

    const observed = await firstProcess.read();
    expect(observed).toEqual({
      health: "valid",
      config: { version: 1, enabled: false, reviewer: REVIEWER, revision: 2 },
    });
  });

  it("removes its private temporary file after a successful commit", async () => {
    const { configPath } = await configFixture();
    await new GlobalConfigStore({ configPath }).setReviewer(REVIEWER);
    expect((await readdir(dirname(configPath))).sort()).toEqual([
      "permissions.json",
      "permissions.json.revision",
      "permissions.json.revision.recovery",
    ]);
  });
});

describe("I10/I13 fault and atomic-failure behavior", () => {
  it.each([
    ["truncated JSON", '{"version":1', undefined],
    ["wrong version", '{"version":2,"enabled":true,"reviewer":null,"revision":7}', 7],
    ["unknown field", '{"version":1,"enabled":true,"reviewer":null,"revision":8,"ask":true}', 8],
    ["missing field", '{"version":1,"enabled":true,"revision":9}', 9],
    ["wrong enabled type", '{"version":1,"enabled":"yes","reviewer":null,"revision":10}', 10],
    ["negative revision", '{"version":1,"enabled":true,"reviewer":null,"revision":-1}', undefined],
    ["invalid thinking level", '{"version":1,"enabled":true,"reviewer":{"provider":"p","modelId":"m","thinkingLevel":"ask"},"revision":12}', 12],
    ["partial reviewer", '{"version":1,"enabled":true,"reviewer":{"provider":"p","modelId":"m"},"revision":13}', 13],
  ] as const)("fails closed for %s", async (_label, contents, revisionHint) => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, contents, "utf8");

    const state = await readGlobalConfig(configPath);
    expect(state.health).toBe("fault");
    if (state.health === "fault") expect(state.revisionHint).toBe(revisionHint);
  });

  it("does not mutate faulted state through normal setters and can explicitly repair it", async () => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{"version":9,"enabled":false,"reviewer":null,"revision":41}',
      "utf8",
    );
    await Promise.all([
      writeFile(`${configPath}.revision`, "41\n", "utf8"),
      writeFile(`${configPath}.revision.recovery`, "41\n", "utf8"),
    ]);
    const store = new GlobalConfigStore({ configPath });

    await expect(store.setEnabled(true)).rejects.toBeInstanceOf(ConfigFaultError);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      version: 9,
      enabled: false,
      reviewer: null,
      revision: 41,
    });

    const repaired = await store.repair({ enabled: true, reviewer: REVIEWER });
    expect(repaired).toEqual({ version: 1, enabled: true, reviewer: REVIEWER, revision: 42 });
    await expect(store.read()).resolves.toEqual({ health: "valid", config: repaired });
  });

  it("uses a valid monotonic repair revision from the malformed state's hint", async () => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"version":2,"enabled":true,"reviewer":null,"revision":8}', "utf8");
    await Promise.all([
      writeFile(`${configPath}.revision`, "8\n", "utf8"),
      writeFile(`${configPath}.revision.recovery`, "8\n", "utf8"),
    ]);

    const repaired = await new GlobalConfigStore({ configPath }).repair({
      enabled: false,
      reviewer: null,
    });
    expect(repaired.revision).toBe(9);
  });

  it("never reuses a revision across repeated repairs whose malformed state has no hint", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    const first = await store.setReviewer(REVIEWER);

    await writeFile(configPath, "{malformed", "utf8");
    const repairedOnce = await store.repair({ enabled: true, reviewer: REVIEWER });
    await writeFile(configPath, "{malformed-again", "utf8");
    const repairedTwice = await store.repair({ enabled: true, reviewer: REVIEWER });

    expect(first.revision).toBe(1);
    expect(repairedOnce.revision).toBe(2);
    expect(repairedTwice.revision).toBe(3);
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe("3\n");
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe("3\n");
  });

  it.each([
    ["primary", ".revision", "invalid durable revision counter"],
    ["recovery", ".revision.recovery", "invalid durable revision recovery watermark"],
  ] as const)("reports a valid config as faulted when the %s watermark is corrupt", async (
    _label,
    suffix,
    expectedError,
  ) => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    const committed = await store.setReviewer(REVIEWER);

    await writeFile(`${configPath}${suffix}`, "not-a-revision\n", "utf8");
    const primaryFault = await store.read();
    expect(primaryFault).toMatchObject({
      health: "fault",
      revisionHint: committed.revision,
      recoverableConfig: committed,
    });
    if (primaryFault.health === "fault") {
      expect(primaryFault.error).toContain(expectedError);
    }
    await expect(store.setEnabled(false)).rejects.toBeInstanceOf(ConfigFaultError);

    const repaired = await store.repair({ enabled: false, reviewer: REVIEWER });
    expect(repaired.revision).toBe(committed.revision + 1);
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe(`${repaired.revision}\n`);
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe(
      `${repaired.revision}\n`,
    );
    await expect(store.read()).resolves.toEqual({ health: "valid", config: repaired });
  });

  it("repairs simultaneous config and primary-counter faults from the recovery watermark", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    const committed = await store.setReviewer(REVIEWER);

    await Promise.all([
      writeFile(configPath, "{broken-config", "utf8"),
      writeFile(`${configPath}.revision`, "broken-counter", "utf8"),
    ]);
    const fault = await store.read();
    expect(fault.health).toBe("fault");
    if (fault.health === "fault") {
      expect(fault.revisionHint).toBe(committed.revision);
      expect(fault.error).toContain("invalid global permission JSON");
      expect(fault.error).toContain("invalid durable revision counter");
    }

    const repaired = await store.repair({ enabled: true, reviewer: REVIEWER });
    expect(repaired.revision).toBe(committed.revision + 1);
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe(`${repaired.revision}\n`);
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe(
      `${repaired.revision}\n`,
    );
    await expect(store.read()).resolves.toEqual({ health: "valid", config: repaired });
  });

  it("refuses unsafe repair when neither present revision watermark is valid", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    await store.setReviewer(REVIEWER);
    await Promise.all([
      writeFile(`${configPath}.revision`, "broken-primary", "utf8"),
      writeFile(`${configPath}.revision.recovery`, "broken-recovery", "utf8"),
    ]);

    await expect(store.repair({ enabled: true, reviewer: REVIEWER })).rejects.toThrow(
      "neither durable watermark is valid",
    );
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe("broken-primary");
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe("broken-recovery");
  });

  it("refuses to infer history when a non-missing config has lost both watermarks", async () => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{"version":9,"enabled":true,"reviewer":null,"revision":41}',
      "utf8",
    );
    const store = new GlobalConfigStore({ configPath });

    await expect(store.repair({ enabled: true, reviewer: REVIEWER })).rejects.toThrow(
      "neither durable watermark is valid",
    );
    await expect(readFile(`${configPath}.revision`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${configPath}.revision.recovery`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never reports exhausted revision metadata as healthy", async () => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    const exhausted = {
      version: 1 as const,
      enabled: true,
      reviewer: REVIEWER,
      revision: Number.MAX_SAFE_INTEGER,
    };
    await Promise.all([
      writeFile(configPath, `${serializeGlobalConfig(exhausted)}\n`, "utf8"),
      writeFile(`${configPath}.revision`, `${String(Number.MAX_SAFE_INTEGER)}\n`, "utf8"),
      writeFile(
        `${configPath}.revision.recovery`,
        `${String(Number.MAX_SAFE_INTEGER)}\n`,
        "utf8",
      ),
    ]);
    const store = new GlobalConfigStore({ configPath });

    const state = await store.read();
    expect(state.health).toBe("fault");
    if (state.health === "fault") expect(state.error).toContain("revision space is exhausted");
    await expect(store.setEnabled(false)).rejects.toBeInstanceOf(ConfigFaultError);
    await expect(store.repair({ enabled: false, reviewer: REVIEWER })).rejects.toThrow(
      "revision is exhausted",
    );
  });

  it("detects inconsistent valid watermarks and repairs above their maximum", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    await store.setReviewer(REVIEWER);
    await writeFile(`${configPath}.revision.recovery`, "7\n", "utf8");

    const fault = await store.read();
    expect(fault.health).toBe("fault");
    if (fault.health === "fault") expect(fault.error).toContain("metadata disagrees");
    const repaired = await store.repair({ enabled: true, reviewer: REVIEWER });
    expect(repaired.revision).toBe(8);
  });

  it("turns a crash between watermark publications into explicit repairable Fault", async () => {
    const { configPath } = await configFixture();
    const originalStore = new GlobalConfigStore({ configPath });
    const original = await originalStore.setReviewer(REVIEWER);
    let renameCount = 0;
    let injected = false;
    const fileSystem = realFileSystem({
      async rename(from, to) {
        renameCount += 1;
        if (!injected && renameCount === 2) {
          injected = true;
          throw Object.assign(new Error("injected primary-counter rename failure"), {
            code: "EIO",
          });
        }
        await rename(from, to);
      },
    });
    const store = new GlobalConfigStore({
      configPath,
      fileSystem,
      lock: DIRECT_LOCK,
      createId: () => `staged-${String(renameCount)}`,
    });

    await expect(store.setEnabled(false)).rejects.toThrow(
      "injected primary-counter rename failure",
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(original);
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe("1\n");
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe("2\n");
    const fault = await store.read();
    expect(fault.health).toBe("fault");
    if (fault.health === "fault") expect(fault.error).toContain("metadata disagrees");

    const repaired = await store.repair({ enabled: false, reviewer: REVIEWER });
    expect(repaired.revision).toBe(3);
    await expect(store.read()).resolves.toEqual({ health: "valid", config: repaired });
  });

  it("fails closed and repairs after both watermarks publish before the first config", async () => {
    const { configPath } = await configFixture();
    let renameCount = 0;
    let injected = false;
    const fileSystem = realFileSystem({
      async rename(from, to) {
        renameCount += 1;
        if (!injected && renameCount === 3) {
          injected = true;
          throw Object.assign(new Error("injected first-config rename failure"), {
            code: "EIO",
          });
        }
        await rename(from, to);
      },
    });
    const store = new GlobalConfigStore({
      configPath,
      fileSystem,
      lock: DIRECT_LOCK,
      createId: () => `first-config-${String(renameCount)}`,
    });

    await expect(store.setReviewer(REVIEWER)).rejects.toThrow(
      "injected first-config rename failure",
    );
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(`${configPath}.revision`, "utf8")).toBe("1\n");
    expect(await readFile(`${configPath}.revision.recovery`, "utf8")).toBe("1\n");
    const fault = await store.read();
    expect(fault.health).toBe("fault");
    if (fault.health === "fault") {
      expect(fault.error).toContain(
        "global permission state is missing while durable revision metadata exists",
      );
    }

    const repaired = await store.repair({ enabled: true, reviewer: REVIEWER });
    expect(repaired.revision).toBe(2);
    await expect(store.read()).resolves.toEqual({ health: "valid", config: repaired });
  });

  it("leaves the old complete state intact and cleans up when rename fails", async () => {
    const { configPath } = await configFixture();
    await mkdir(dirname(configPath), { recursive: true });
    const old = { version: 1 as const, enabled: true, reviewer: REVIEWER, revision: 5 };
    await writeFile(configPath, `${serializeGlobalConfig(old)}\n`, { encoding: "utf8", mode: 0o600 });
    await Promise.all([
      writeFile(`${configPath}.revision`, "5\n", { encoding: "utf8", mode: 0o600 }),
      writeFile(`${configPath}.revision.recovery`, "5\n", { encoding: "utf8", mode: 0o600 }),
    ]);

    const fileSystem = realFileSystem({
      rename: async () => {
        const error = new Error("injected rename failure");
        Object.assign(error, { code: "EIO" });
        throw error;
      },
    });
    const store = new GlobalConfigStore({ configPath, fileSystem, lock: DIRECT_LOCK, createId: () => "failure" });

    await expect(store.setEnabled(false)).rejects.toThrow("injected rename failure");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(old);
    expect((await readdir(dirname(configPath))).sort()).toEqual([
      "permissions.json",
      "permissions.json.revision",
      "permissions.json.revision.recovery",
    ]);
  });

  it("performs write, file fsync, close, rename, then best-effort directory fsync", async () => {
    const { configPath } = await configFixture();
    const events: string[] = [];
    const fileSystem = loggingFileSystem(events);
    await new GlobalConfigStore({
      configPath,
      fileSystem,
      lock: DIRECT_LOCK,
      createId: () => "ordering",
    }).setEnabled(false);

    expect(events).toEqual([
      "mkdir",
      "read",
      "read",
      "read",
      "open-file",
      "write-file",
      "sync-file",
      "close-file",
      "rename",
      "open-directory",
      "sync-directory",
      "close-directory",
      "open-file",
      "write-file",
      "sync-file",
      "close-file",
      "rename",
      "open-directory",
      "sync-directory",
      "close-directory",
      "open-file",
      "write-file",
      "sync-file",
      "close-file",
      "rename",
      "open-directory",
      "sync-directory",
      "close-directory",
    ]);
  });
});

describe("I2 strict config codec", () => {
  it("round-trips the exact schema deterministically", () => {
    const config = { version: 1 as const, enabled: false, reviewer: REVIEWER, revision: 22 };
    expect(parseGlobalConfig(JSON.parse(serializeGlobalConfig(config)))).toEqual(config);
    expect(serializeGlobalConfig(config)).toBe(
      '{"version":1,"enabled":false,"reviewer":{"provider":"provider-a","modelId":"model-a","thinkingLevel":"medium"},"revision":22}',
    );
  });

  it("rejects invalid mutation values before committing", async () => {
    const { configPath } = await configFixture();
    const store = new GlobalConfigStore({ configPath });
    await expect(store.setEnabled("yes" as unknown as boolean)).rejects.toThrow(TypeError);
    await expect(store.setReviewer({ ...REVIEWER, provider: "" })).rejects.toThrow(TypeError);
    await expect(store.setReviewer({ ...REVIEWER, thinkingLevel: "ask" as "high" })).rejects.toThrow(TypeError);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function realFileSystem(overrides: Partial<ConfigFileSystem> = {}): ConfigFileSystem {
  return {
    mkdir,
    readFile,
    open,
    rename,
    unlink,
    ...overrides,
  };
}

function loggingFileSystem(events: string[]): ConfigFileSystem {
  return {
    async mkdir(path, options) {
      events.push("mkdir");
      return mkdir(path, options);
    },
    async readFile(path, encoding) {
      events.push("read");
      return readFile(path, encoding);
    },
    async open(path, flags, mode) {
      const isDirectory = flags === constants.O_RDONLY;
      events.push(isDirectory ? "open-directory" : "open-file");
      const handle = await open(path, flags, mode);
      const label = isDirectory ? "directory" : "file";
      const wrapped: DurableHandle = {
        async writeFile(data, options) {
          events.push(`write-${label}`);
          await handle.writeFile(data, options);
        },
        async sync() {
          events.push(`sync-${label}`);
          await handle.sync();
        },
        async close() {
          events.push(`close-${label}`);
          await handle.close();
        },
      };
      return wrapped;
    },
    async rename(from, to) {
      events.push("rename");
      await rename(from, to);
    },
    async unlink(path) {
      events.push("unlink");
      await unlink(path);
    },
  };
}
