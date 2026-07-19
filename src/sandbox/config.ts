import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

export const PROTECTED_WORKSPACE_NAMES = [".git", ".agents", ".codex", ".pi"] as const;

const MAX_GIT_POINTER_BYTES = 8 * 1024;

export interface StrongSandboxConfig {
  readonly config: SandboxRuntimeConfig;
  readonly workspace: string;
  readonly writableRoots: readonly string[];
  readonly protectedPaths: readonly string[];
}

export interface StrongSandboxConfigOptions {
  readonly homeDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly systemTemporaryDirectory?: string;
  /** Extension-owned durable state/lock paths that must never be writable. */
  readonly additionalDenyWrite?: readonly string[];
}

/** Build and schema-validate the one policy used by every strong backend. */
export function createStrongSandboxConfig(
  cwd: string,
  options: StrongSandboxConfigOptions = {},
): StrongSandboxConfig {
  const workspace = canonicalDirectory(cwd, "workspace");
  if (workspace === parse(workspace).root) {
    throw new Error("Refusing to make the filesystem root a writable workspace");
  }

  const temporaryDirectory = canonicalDirectory(
    options.temporaryDirectory ?? tmpdir(),
    "temporary directory",
  );
  const systemTemporaryDirectory = options.systemTemporaryDirectory ?? "/tmp";
  const writableRoots = unique([
    workspace,
    temporaryDirectory,
    ...(existsSync(systemTemporaryDirectory)
      ? [canonicalDirectory(systemTemporaryDirectory, "system temporary directory")]
      : []),
  ]);
  for (const writableRoot of writableRoots) {
    if (writableRoot === parse(writableRoot).root) {
      throw new Error(`Refusing to make the filesystem root writable: ${writableRoot}`);
    }
  }

  const homeDirectory = canonicalDirectory(options.homeDirectory ?? homedir(), "home directory");
  const protectedPaths = collectProtectedPaths(
    workspace,
    homeDirectory,
    options.additionalDenyWrite ?? [],
  );

  // SRT's library API accepts the TypeScript shape without parsing it. Parse
  // here so a typo cannot silently weaken a policy field.
  const config = SandboxRuntimeConfigSchema.parse({
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: writableRoots,
      denyWrite: protectedPaths,
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowPty: false,
  });

  return {
    config,
    workspace,
    writableRoots: Object.freeze([...writableRoots]),
    protectedPaths: Object.freeze([...protectedPaths]),
  };
}

function collectProtectedPaths(
  workspace: string,
  homeDirectory: string,
  additionalDenyWrite: readonly string[],
): string[] {
  const paths: string[] = [];
  for (const name of PROTECTED_WORKSPACE_NAMES) {
    addPathAndExistingTarget(paths, resolve(workspace, name));
  }

  collectResolvedGitDirectories(paths, resolve(workspace, ".git"));

  // SRT always prepends these two home-directory locations to its write
  // allowlist. Explicit deny carve-outs are required for workspace+temp.
  addPathAndExistingTarget(paths, resolve(homeDirectory, ".npm/_logs"));
  addPathAndExistingTarget(paths, resolve(homeDirectory, ".claude/debug"));

  for (const path of additionalDenyWrite) {
    if (!isAbsolute(path)) {
      throw new Error(`Additional deny-write paths must be absolute: ${path}`);
    }
    addPathAndExistingTarget(paths, path);
  }
  return unique(paths);
}

function collectResolvedGitDirectories(paths: string[], dotGitPath: string): void {
  if (!existsSync(dotGitPath)) return;

  let gitDirectory: string | undefined;
  try {
    const stat = lstatSync(dotGitPath);
    if (stat.isDirectory() || stat.isSymbolicLink()) {
      gitDirectory = canonicalIfExisting(dotGitPath);
    } else if (stat.isFile()) {
      gitDirectory = readPointerPath(dotGitPath, "gitdir:");
    }
  } catch {
    return;
  }

  if (gitDirectory === undefined) return;
  addPathAndExistingTarget(paths, gitDirectory);

  const commonDirectory = readPointerPath(resolve(gitDirectory, "commondir"));
  if (commonDirectory !== undefined) addPathAndExistingTarget(paths, commonDirectory);
}

function readPointerPath(file: string, prefix?: string): string | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_GIT_POINTER_BYTES) return undefined;
    const firstLine = readFileSync(file, "utf8").split(/\r?\n/u, 1)[0];
    if (firstLine === undefined || firstLine.includes("\0")) return undefined;

    let raw = firstLine.trim();
    if (prefix !== undefined) {
      if (!raw.toLowerCase().startsWith(prefix)) return undefined;
      raw = raw.slice(prefix.length).trim();
    }
    if (raw.length === 0) return undefined;

    const target = isAbsolute(raw) ? raw : resolve(file, "..", raw);
    return canonicalIfExisting(target);
  } catch {
    return undefined;
  }
}

function addPathAndExistingTarget(paths: string[], path: string): void {
  const absolute = resolve(path);
  paths.push(absolute);
  const canonical = canonicalIfExisting(absolute);
  if (canonical !== absolute) paths.push(canonical);
}

function canonicalIfExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function canonicalDirectory(path: string, label: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return canonical;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
