import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import {
  CONFIG_VERSION,
  DEFAULT_GLOBAL_CONFIG,
  assertRevision,
  cloneGlobalConfig,
  cloneReviewerSelection,
  isModelThinkingLevel,
  nextRevision,
  reviewerSelectionsEqual,
} from "../domain.ts";
import type { GlobalConfig, GlobalState, ReviewerSelection } from "../domain.ts";

export interface DurableHandle {
  writeFile(data: string, options: { encoding: "utf8" }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ConfigFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  open(path: string, flags: string | number, mode?: number): Promise<DurableHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ExclusiveLock {
  run<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

export interface GlobalConfigStoreOptions {
  configPath: string;
  fileSystem?: ConfigFileSystem;
  lock?: ExclusiveLock;
  createId?: () => string;
}

export interface GlobalConfigMutation {
  enabled: boolean;
  reviewer: ReviewerSelection | null;
}

export class ConfigFaultError extends Error {
  readonly state: GlobalState;

  constructor(state: GlobalState) {
    super(state.health === "fault" ? state.error : "global configuration is not faulted");
    this.name = "ConfigFaultError";
    this.state = state;
  }
}

export class GlobalConfigStore {
  readonly configPath: string;
  readonly revisionPath: string;
  readonly revisionRecoveryPath: string;
  private readonly fileSystem: ConfigFileSystem;
  private readonly lock: ExclusiveLock;
  private readonly createId: () => string;

  constructor(options: GlobalConfigStoreOptions) {
    if (options.configPath.length === 0) throw new TypeError("configPath must not be empty");
    this.configPath = options.configPath;
    this.revisionPath = `${options.configPath}.revision`;
    this.revisionRecoveryPath = `${options.configPath}.revision.recovery`;
    this.fileSystem = options.fileSystem ?? NODE_CONFIG_FILE_SYSTEM;
    this.lock = options.lock ?? PROPER_FILE_LOCK;
    this.createId = options.createId ?? randomUUID;
  }

  async read(): Promise<GlobalState> {
    const directory = dirname(this.configPath);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    return this.lock.run(directory, async () =>
      (await readDurableSnapshot(
        this.configPath,
        this.revisionPath,
        this.revisionRecoveryPath,
        this.fileSystem,
      )).state,
    );
  }

  async setEnabled(enabled: boolean): Promise<GlobalConfig> {
    return this.update((current) => ({ enabled, reviewer: current.reviewer }));
  }

  async setReviewer(reviewer: ReviewerSelection | null): Promise<GlobalConfig> {
    validateReviewer(reviewer);
    const capturedReviewer = cloneReviewerSelection(reviewer);
    return this.update((current) => ({ enabled: current.enabled, reviewer: capturedReviewer }));
  }

  async update(
    mutation: (current: Readonly<GlobalConfig>) => Readonly<GlobalConfigMutation>,
  ): Promise<GlobalConfig> {
    const directory = dirname(this.configPath);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });

    return this.lock.run(directory, async () => {
      const snapshot = await readDurableSnapshot(
        this.configPath,
        this.revisionPath,
        this.revisionRecoveryPath,
        this.fileSystem,
      );
      const observed = snapshot.state;
      if (observed.health === "fault") throw new ConfigFaultError(observed);

      const current = cloneGlobalConfig(observed.config);
      const desired = mutation(cloneGlobalConfig(current));
      validateMutation(desired);

      if (
        current.enabled === desired.enabled &&
        reviewerSelectionsEqual(current.reviewer, desired.reviewer)
      ) {
        return current;
      }

      const next: GlobalConfig = {
        version: CONFIG_VERSION,
        enabled: desired.enabled,
        reviewer: cloneReviewerSelection(desired.reviewer),
        revision: nextRevision(snapshot.revisionFloor),
      };
      await this.writeCommitted(next);
      return cloneGlobalConfig(next);
    });
  }

  async repair(mutation: Readonly<GlobalConfigMutation>): Promise<GlobalConfig> {
    validateMutation(mutation);
    const capturedMutation: GlobalConfigMutation = {
      enabled: mutation.enabled,
      reviewer: cloneReviewerSelection(mutation.reviewer),
    };
    const directory = dirname(this.configPath);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });

    return this.lock.run(directory, async () => {
      const snapshot = await readDurableSnapshot(
        this.configPath,
        this.revisionPath,
        this.revisionRecoveryPath,
        this.fileSystem,
      );
      const observed = snapshot.state;
      if (observed.health !== "fault") {
        return this.updateWithoutLock(
          observed.config,
          capturedMutation,
          snapshot.revisionFloor,
        );
      }

      const repairFloor = revisionRepairFloor(snapshot.artifacts);
      const repaired: GlobalConfig = {
        version: CONFIG_VERSION,
        enabled: capturedMutation.enabled,
        reviewer: cloneReviewerSelection(capturedMutation.reviewer),
        revision: nextRevision(repairFloor),
      };
      await this.writeCommitted(repaired);
      return cloneGlobalConfig(repaired);
    });
  }

  private async updateWithoutLock(
    currentValue: Readonly<GlobalConfig>,
    mutation: Readonly<GlobalConfigMutation>,
    revisionFloor: number,
  ): Promise<GlobalConfig> {
    const current = cloneGlobalConfig(currentValue);
    if (
      current.enabled === mutation.enabled &&
      reviewerSelectionsEqual(current.reviewer, mutation.reviewer)
    ) {
      return current;
    }
    const next: GlobalConfig = {
      version: CONFIG_VERSION,
      enabled: mutation.enabled,
      reviewer: cloneReviewerSelection(mutation.reviewer),
      revision: nextRevision(revisionFloor),
    };
    await this.writeCommitted(next);
    return cloneGlobalConfig(next);
  }

  private async writeCommitted(config: Readonly<GlobalConfig>): Promise<void> {
    const revisionContents = `${String(config.revision)}\n`;
    // The recovery watermark is published first. A crash at either metadata
    // rename is observable as Fault and an explicit repair uses the larger
    // surviving valid watermark. Readers share the writer lock, so they never
    // observe this intentionally staged publication while it is in progress.
    await this.writeAtomicFile(this.revisionRecoveryPath, revisionContents);
    await this.writeAtomicFile(this.revisionPath, revisionContents);
    await this.writeAtomicFile(this.configPath, `${serializeGlobalConfig(config)}\n`);
  }

  private async writeAtomicFile(targetPath: string, contents: string): Promise<void> {
    const directory = dirname(targetPath);
    const temporaryPath = `${targetPath}.${process.pid}.${this.createId()}.tmp`;
    let handle: DurableHandle | undefined;
    let renamed = false;

    try {
      handle = await this.fileSystem.open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.fileSystem.rename(temporaryPath, targetPath);
      renamed = true;
      await bestEffortDirectorySync(directory, this.fileSystem);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (!renamed) await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function readGlobalConfig(
  configPath: string,
  fileSystem: ConfigFileSystem = NODE_CONFIG_FILE_SYSTEM,
): Promise<GlobalState> {
  return (
    await readDurableSnapshot(
      configPath,
      `${configPath}.revision`,
      `${configPath}.revision.recovery`,
      fileSystem,
    )
  ).state;
}

type ConfigArtifact =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly config: GlobalConfig }
  | { readonly kind: "fault"; readonly error: string; readonly revisionHint?: number };

type RevisionArtifact =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly value: number }
  | { readonly kind: "fault"; readonly error: string };

interface DurableArtifacts {
  readonly config: ConfigArtifact;
  readonly counter: RevisionArtifact;
  readonly recovery: RevisionArtifact;
}

interface DurableSnapshot {
  readonly state: GlobalState;
  readonly revisionFloor: number;
  readonly artifacts: DurableArtifacts;
}

async function readDurableSnapshot(
  configPath: string,
  revisionPath: string,
  revisionRecoveryPath: string,
  fileSystem: ConfigFileSystem,
): Promise<DurableSnapshot> {
  const [config, counter, recovery] = await Promise.all([
    readConfigArtifact(configPath, fileSystem),
    readRevisionArtifact(revisionPath, "durable revision counter", fileSystem),
    readRevisionArtifact(
      revisionRecoveryPath,
      "durable revision recovery watermark",
      fileSystem,
    ),
  ]);
  const artifacts: DurableArtifacts = { config, counter, recovery };
  const validRevisionValues = revisionValues(artifacts);
  const revisionFloor = Math.max(0, ...validRevisionValues);
  const errors: string[] = [];

  if (config.kind === "fault") errors.push(config.error);
  if (counter.kind === "fault") errors.push(counter.error);
  if (recovery.kind === "fault") errors.push(recovery.error);

  const counterMissing = counter.kind === "missing";
  const recoveryMissing = recovery.kind === "missing";
  if (counterMissing !== recoveryMissing) {
    errors.push("durable revision metadata is incomplete");
  } else if (counter.kind === "valid" && recovery.kind === "valid") {
    if (counter.value !== recovery.value) {
      errors.push(
        `durable revision metadata disagrees (${counter.value} != ${recovery.value})`,
      );
    }
  }

  if (config.kind !== "missing" && counterMissing && recoveryMissing) {
    errors.push("durable revision metadata is missing");
  }
  if (config.kind === "missing" && (!counterMissing || !recoveryMissing)) {
    errors.push("global permission state is missing while durable revision metadata exists");
  }
  if (
    config.kind === "valid" &&
    counter.kind === "valid" &&
    recovery.kind === "valid" &&
    counter.value < config.config.revision
  ) {
    errors.push(
      `durable revision metadata ${counter.value} precedes config revision ${config.config.revision}`,
    );
  }
  if (
    counter.kind === "valid" &&
    recovery.kind === "valid" &&
    counter.value === Number.MAX_SAFE_INTEGER
  ) {
    errors.push("durable revision space is exhausted");
  }

  if (errors.length > 0) {
    const revisionHint = Math.max(
      0,
      ...validRevisionValues,
      config.kind === "fault" ? (config.revisionHint ?? 0) : 0,
    );
    const state: GlobalState = {
      health: "fault",
      error: errors.join("; "),
      ...(revisionHint === 0 ? {} : { revisionHint }),
      ...(config.kind === "valid"
        ? { recoverableConfig: cloneGlobalConfig(config.config) }
        : {}),
    };
    return { state, revisionFloor, artifacts };
  }

  if (config.kind === "missing") {
    return {
      state: { health: "missing", config: cloneGlobalConfig(DEFAULT_GLOBAL_CONFIG) },
      revisionFloor,
      artifacts,
    };
  }

  if (config.kind === "valid") {
    return {
      state: { health: "valid", config: cloneGlobalConfig(config.config) },
      revisionFloor,
      artifacts,
    };
  }
  throw new Error("unreachable durable-state composition");
}

async function readConfigArtifact(
  configPath: string,
  fileSystem: ConfigFileSystem,
): Promise<ConfigArtifact> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return {
      kind: "fault",
      error: describeError("cannot read global permission state", error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    return {
      kind: "fault",
      error: describeError("invalid global permission JSON", error),
    };
  }

  const revisionHint = extractRevisionHint(parsed);
  try {
    return { kind: "valid", config: parseGlobalConfig(parsed) };
  } catch (error) {
    return {
      kind: "fault",
      error: describeError("invalid global permission state", error),
      ...(revisionHint === undefined ? {} : { revisionHint }),
    };
  }
}

async function readRevisionArtifact(
  path: string,
  label: string,
  fileSystem: ConfigFileSystem,
): Promise<RevisionArtifact> {
  let contents: string;
  try {
    contents = await fileSystem.readFile(path, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "fault", error: describeError(`cannot read ${label}`, error) };
  }

  const normalized = contents.trim();
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    return { kind: "fault", error: `invalid ${label}: expected a non-negative integer` };
  }
  const value = Number(normalized);
  try {
    assertRevision(value, label);
  } catch (error) {
    return { kind: "fault", error: describeError(`invalid ${label}`, error) };
  }
  return { kind: "valid", value };
}

function revisionValues(artifacts: DurableArtifacts): number[] {
  const values: number[] = [];
  if (artifacts.config.kind === "valid") values.push(artifacts.config.config.revision);
  if (artifacts.counter.kind === "valid") values.push(artifacts.counter.value);
  if (artifacts.recovery.kind === "valid") values.push(artifacts.recovery.value);
  return values;
}

function revisionRepairFloor(artifacts: DurableArtifacts): number {
  const validMetadata = [artifacts.counter, artifacts.recovery].filter(
    (artifact): artifact is Extract<RevisionArtifact, { kind: "valid" }> =>
      artifact.kind === "valid",
  );
  if (validMetadata.length === 0) {
    throw new ConfigFaultError({
      health: "fault",
      error:
        "revision metadata cannot be repaired safely because neither durable watermark is valid",
    });
  }

  const configFloor =
    artifacts.config.kind === "valid"
      ? artifacts.config.config.revision
      : artifacts.config.kind === "fault"
        ? (artifacts.config.revisionHint ?? 0)
        : 0;
  return Math.max(configFloor, 0, ...validMetadata.map((artifact) => artifact.value));
}

export function parseGlobalConfig(value: unknown): GlobalConfig {
  if (!isPlainRecord(value)) throw new TypeError("configuration must be a plain object");
  assertExactKeys(value, ["enabled", "reviewer", "revision", "version"], "configuration");
  if (value.version !== CONFIG_VERSION) throw new TypeError(`unsupported configuration version ${String(value.version)}`);
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  assertRevision(value.revision, "global revision");

  return {
    version: CONFIG_VERSION,
    enabled: value.enabled,
    reviewer: parseReviewer(value.reviewer),
    revision: value.revision,
  };
}

export function serializeGlobalConfig(config: Readonly<GlobalConfig>): string {
  const parsed = parseGlobalConfig(config);
  return JSON.stringify({
    version: CONFIG_VERSION,
    enabled: parsed.enabled,
    reviewer: parsed.reviewer,
    revision: parsed.revision,
  });
}

const NODE_CONFIG_FILE_SYSTEM: ConfigFileSystem = {
  mkdir,
  readFile,
  open,
  rename,
  unlink,
};

const PROPER_FILE_LOCK: ExclusiveLock = {
  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 40, factor: 1.25, minTimeout: 10, maxTimeout: 250 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  },
};

async function bestEffortDirectorySync(directory: string, fileSystem: ConfigFileSystem): Promise<void> {
  let handle: DurableHandle | undefined;
  try {
    handle = await fileSystem.open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some supported filesystems do not permit fsync on a directory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseReviewer(value: unknown): ReviewerSelection | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new TypeError("reviewer must be null or a plain object");
  assertExactKeys(value, ["modelId", "provider", "thinkingLevel"], "reviewer");
  const reviewer: ReviewerSelection = {
    provider: requireNonEmptyString(value.provider, "reviewer.provider"),
    modelId: requireNonEmptyString(value.modelId, "reviewer.modelId"),
    thinkingLevel: value.thinkingLevel as ReviewerSelection["thinkingLevel"],
  };
  validateReviewer(reviewer);
  return reviewer;
}

function validateReviewer(value: ReviewerSelection | null): void {
  if (value === null) return;
  requireNonEmptyString(value.provider, "reviewer.provider");
  requireNonEmptyString(value.modelId, "reviewer.modelId");
  if (!isModelThinkingLevel(value.thinkingLevel)) {
    throw new TypeError(`invalid reviewer.thinkingLevel ${String(value.thinkingLevel)}`);
  }
}

function validateMutation(value: Readonly<GlobalConfigMutation>): void {
  if (typeof value !== "object" || value === null) throw new TypeError("configuration mutation must be an object");
  if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
  validateReviewer(value.reviewer);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function extractRevisionHint(value: unknown): number | undefined {
  if (!isPlainRecord(value)) return undefined;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    ? (value.revision as number)
    : undefined;
}

function describeError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
