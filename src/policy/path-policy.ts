import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import type { AdmissionDisposition } from "../domain.ts";

export const READ_ONLY_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
export const DIRECT_MUTATION_TOOLS = ["write", "edit"] as const;
export const DEFAULT_PROTECTED_METADATA_NAMES = [".git", ".agents", ".codex", ".pi"] as const;
export const MAX_DIRECT_PATH_CODE_UNITS = 32 * 1024;
const MAX_GIT_POINTER_BYTES = 8 * 1024;

export type ReadOnlyFileToolName = (typeof READ_ONLY_FILE_TOOLS)[number];
export type DirectMutationToolName = (typeof DIRECT_MUTATION_TOOLS)[number];

export interface PathPolicyFileSystem {
  lstat(path: string): Promise<Stats>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface StaticPathPolicyOptions {
  cwd: string;
  workspaceRoots: readonly string[];
  temporaryRoots?: readonly string[];
  resolvedGitDirectories?: readonly string[];
  /** Extension-owned control-plane paths that Auto file tools may never mutate. */
  deniedRoots?: readonly string[];
  protectedMetadataNames?: readonly string[];
  fileSystem?: PathPolicyFileSystem;
  maxSymlinks?: number;
}

export interface DirectFileToolRequest {
  toolName: string;
  input: unknown;
}

export interface PathPolicyDecision {
  disposition: AdmissionDisposition;
  reason: string;
  canonicalTarget?: string;
  writableRoot?: string;
  protectedRoot?: string;
  deniedRoot?: string;
}

export class PathResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PathResolutionError";
  }
}

export class StaticPathPolicy {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly temporaryRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly protectedRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  private readonly fileSystem: PathPolicyFileSystem;
  private readonly maxSymlinks: number;

  private constructor(materialized: MaterializedPolicy) {
    this.cwd = materialized.cwd;
    this.workspaceRoots = Object.freeze(materialized.workspaceRoots);
    this.temporaryRoots = Object.freeze(materialized.temporaryRoots);
    this.writableRoots = Object.freeze(materialized.writableRoots);
    this.protectedRoots = Object.freeze(materialized.protectedRoots);
    this.deniedRoots = Object.freeze(materialized.deniedRoots);
    this.fileSystem = materialized.fileSystem;
    this.maxSymlinks = materialized.maxSymlinks;
  }

  static async create(options: StaticPathPolicyOptions): Promise<StaticPathPolicy> {
    return new StaticPathPolicy(await materializePolicy(options));
  }

  async classify(request: Readonly<DirectFileToolRequest>): Promise<PathPolicyDecision> {
    if (isReadOnlyFileTool(request.toolName)) {
      return { disposition: "admit", reason: "known read-only file tool" };
    }
    if (!isDirectMutationTool(request.toolName)) {
      return { disposition: "review", reason: "tool is not a known direct file tool" };
    }

    const requestedPath = extractPath(request.input);
    if (requestedPath === null) {
      return { disposition: "review", reason: "direct mutation has no valid path" };
    }

    // Preserve the lexical identity as well as the resolved identity. This
    // prevents a protected/control-plane path that did not exist at startup
    // from becoming statically writable if it is later replaced by a symlink
    // into an otherwise writable root.
    const lexicalTarget = path.resolve(this.cwd, requestedPath);
    const lexicalDeniedRoot = mostSpecificContainingRoot(lexicalTarget, this.deniedRoots);
    if (lexicalDeniedRoot !== undefined) {
      return {
        disposition: "deny",
        reason: "target is extension-owned permission state",
        canonicalTarget: lexicalTarget,
        deniedRoot: lexicalDeniedRoot,
      };
    }
    const lexicalProtectedRoot = mostSpecificContainingRoot(
      lexicalTarget,
      this.protectedRoots,
    );

    let canonicalTarget: string;
    try {
      canonicalTarget = await resolveStaticTarget(requestedPath, this.cwd, {
        fileSystem: this.fileSystem,
        maxSymlinks: this.maxSymlinks,
      });
    } catch (error) {
      return {
        disposition: "review",
        reason: `target could not be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const deniedRoot = mostSpecificContainingRoot(canonicalTarget, this.deniedRoots);
    if (deniedRoot !== undefined) {
      return {
        disposition: "deny",
        reason: "target is extension-owned permission state",
        canonicalTarget,
        deniedRoot,
      };
    }

    const protectedRoot =
      lexicalProtectedRoot ?? mostSpecificContainingRoot(canonicalTarget, this.protectedRoots);
    if (protectedRoot !== undefined) {
      return {
        disposition: "review",
        reason: "target is protected metadata",
        canonicalTarget,
        protectedRoot,
      };
    }

    const writableRoot = mostSpecificContainingRoot(canonicalTarget, this.writableRoots);
    if (writableRoot === undefined) {
      return {
        disposition: "review",
        reason: "target is outside writable roots",
        canonicalTarget,
      };
    }

    return {
      disposition: "admit",
      reason: "target is inside a writable root",
      canonicalTarget,
      writableRoot,
    };
  }
}

export async function createStaticPathPolicy(options: StaticPathPolicyOptions): Promise<StaticPathPolicy> {
  return StaticPathPolicy.create(options);
}

export async function classifyDirectFileTool(
  policy: StaticPathPolicy,
  request: Readonly<DirectFileToolRequest>,
): Promise<PathPolicyDecision> {
  return policy.classify(request);
}

export async function resolveStaticTarget(
  requestedPath: string,
  cwd: string,
  options: {
    fileSystem?: PathPolicyFileSystem;
    maxSymlinks?: number;
  } = {},
): Promise<string> {
  if (requestedPath.length === 0) throw new PathResolutionError("path must not be empty");
  if (requestedPath.length > MAX_DIRECT_PATH_CODE_UNITS) {
    throw new PathResolutionError("path exceeds the static policy input limit");
  }
  if (requestedPath.includes("\0")) throw new PathResolutionError("path contains a NUL byte");
  if (cwd.length === 0) throw new PathResolutionError("cwd must not be empty");

  const fileSystem = options.fileSystem ?? NODE_PATH_FILE_SYSTEM;
  const maxSymlinks = validateMaxSymlinks(options.maxSymlinks ?? 40);
  let absolute: string;
  if (path.isAbsolute(requestedPath)) {
    absolute = requestedPath;
  } else {
    let canonicalCwd: string;
    try {
      canonicalCwd = await fileSystem.realpath(cwd);
    } catch (error) {
      throw new PathResolutionError(`cannot resolve cwd ${cwd}`, { cause: error });
    }
    absolute = `${canonicalCwd}${canonicalCwd.endsWith(path.sep) ? "" : path.sep}${requestedPath}`;
  }
  return resolveAbsoluteTarget(absolute, fileSystem, maxSymlinks);
}

export function pathIsInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isReadOnlyFileTool(toolName: string): toolName is ReadOnlyFileToolName {
  return (READ_ONLY_FILE_TOOLS as readonly string[]).includes(toolName);
}

function isDirectMutationTool(toolName: string): toolName is DirectMutationToolName {
  return (DIRECT_MUTATION_TOOLS as readonly string[]).includes(toolName);
}

interface MaterializedPolicy {
  cwd: string;
  workspaceRoots: string[];
  temporaryRoots: string[];
  writableRoots: string[];
  protectedRoots: string[];
  deniedRoots: string[];
  fileSystem: PathPolicyFileSystem;
  maxSymlinks: number;
}

async function materializePolicy(options: StaticPathPolicyOptions): Promise<MaterializedPolicy> {
  const fileSystem = options.fileSystem ?? NODE_PATH_FILE_SYSTEM;
  const maxSymlinks = validateMaxSymlinks(options.maxSymlinks ?? 40);
  const cwd = await resolveExistingRoot(options.cwd, process.cwd(), fileSystem, maxSymlinks, "cwd");
  if (options.workspaceRoots.length === 0) throw new TypeError("at least one workspace root is required");

  const workspaceRoots = deduplicate(
    await Promise.all(
      options.workspaceRoots.map((root) => resolveExistingRoot(root, cwd, fileSystem, maxSymlinks, "workspace root")),
    ),
  );
  const requestedTemporaryRoots = options.temporaryRoots ?? defaultTemporaryRoots();
  const temporaryRoots = deduplicate(
    await Promise.all(
      requestedTemporaryRoots.map((root) =>
        resolveExistingRoot(root, cwd, fileSystem, maxSymlinks, "temporary root"),
      ),
    ),
  );
  const writableRoots = deduplicate([...workspaceRoots, ...temporaryRoots]);
  const protectedNames = options.protectedMetadataNames ?? DEFAULT_PROTECTED_METADATA_NAMES;
  for (const name of protectedNames) validateProtectedName(name);

  const protectedRoots: string[] = [];
  for (const workspaceRoot of workspaceRoots) {
    for (const name of protectedNames) {
      const lexicalPath = path.join(workspaceRoot, name);
      protectedRoots.push(lexicalPath);
      const resolved = await tryResolveTarget(lexicalPath, workspaceRoot, fileSystem, maxSymlinks);
      if (resolved !== null) protectedRoots.push(resolved);
    }
    const gitDirectory = await detectGitDirectory(workspaceRoot, fileSystem, maxSymlinks);
    if (gitDirectory !== null) protectedRoots.push(gitDirectory);
  }

  for (const gitDirectory of options.resolvedGitDirectories ?? []) {
    protectedRoots.push(await resolveStaticTarget(gitDirectory, cwd, { fileSystem, maxSymlinks }));
  }

  const deniedRoots = deduplicate(
    (
      await Promise.all(
        (options.deniedRoots ?? []).map(async (root) => [
          path.resolve(cwd, root),
          await resolveStaticTarget(root, cwd, { fileSystem, maxSymlinks }),
        ]),
      )
    ).flat(),
  );

  return {
    cwd,
    workspaceRoots,
    temporaryRoots,
    writableRoots,
    protectedRoots: deduplicate(protectedRoots),
    deniedRoots,
    fileSystem,
    maxSymlinks,
  };
}

async function resolveExistingRoot(
  root: string,
  cwd: string,
  fileSystem: PathPolicyFileSystem,
  maxSymlinks: number,
  label: string,
): Promise<string> {
  const resolved = await resolveStaticTarget(root, cwd, { fileSystem, maxSymlinks });
  let stats: Stats;
  try {
    stats = await fileSystem.lstat(resolved);
  } catch (error) {
    throw new PathResolutionError(`${label} does not exist: ${resolved}`, { cause: error });
  }
  if (!stats.isDirectory()) throw new PathResolutionError(`${label} is not a directory: ${resolved}`);
  return fileSystem.realpath(resolved);
}

async function resolveAbsoluteTarget(
  initialAbsolute: string,
  fileSystem: PathPolicyFileSystem,
  maxSymlinks: number,
): Promise<string> {
  const initialParsed = path.parse(initialAbsolute);
  if (initialParsed.root.length === 0) throw new PathResolutionError("target must be absolute");
  let root = initialParsed.root;
  let resolvedComponents: string[] = [];
  let pendingComponents = splitPathComponents(initialAbsolute, root);
  let followedSymlinks = 0;

  while (pendingComponents.length > 0) {
    const component = pendingComponents.shift();
    if (component === undefined || component === "" || component === ".") continue;
    if (component === "..") {
      resolvedComponents.pop();
      continue;
    }

    const current = path.join(root, ...resolvedComponents);
    const candidate = path.join(current, component);
    let stats: Stats;
    try {
      stats = await fileSystem.lstat(candidate);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw new PathResolutionError(`cannot inspect ${candidate}`, { cause: error });
      }

      const unresolved = [component, ...pendingComponents];
      if (unresolved.includes("..")) {
        throw new PathResolutionError("unresolved path suffix contains '..'");
      }
      let canonicalAncestor: string;
      try {
        canonicalAncestor = await fileSystem.realpath(current);
      } catch (ancestorError) {
        throw new PathResolutionError(`cannot resolve nearest existing ancestor ${current}`, {
          cause: ancestorError,
        });
      }
      return path.join(canonicalAncestor, ...unresolved.filter((part) => part !== "" && part !== "."));
    }

    if (!stats.isSymbolicLink()) {
      resolvedComponents.push(component);
      continue;
    }

    followedSymlinks += 1;
    if (followedSymlinks > maxSymlinks) {
      throw new PathResolutionError(`path exceeds ${maxSymlinks} symbolic links`);
    }
    let linkTarget: string;
    try {
      linkTarget = await fileSystem.readlink(candidate);
    } catch (error) {
      throw new PathResolutionError(`cannot read symbolic link ${candidate}`, { cause: error });
    }

    if (path.isAbsolute(linkTarget)) {
      const parsedTarget = path.parse(linkTarget);
      root = parsedTarget.root;
      resolvedComponents = [];
      pendingComponents = [
        ...splitPathComponents(linkTarget, parsedTarget.root),
        ...pendingComponents,
      ];
    } else {
      pendingComponents = [...splitPathComponents(linkTarget, ""), ...pendingComponents];
    }
  }

  const resolved = path.join(root, ...resolvedComponents);
  try {
    return await fileSystem.realpath(resolved);
  } catch (error) {
    throw new PathResolutionError(`cannot resolve ${resolved}`, { cause: error });
  }
}

function splitPathComponents(value: string, root: string): string[] {
  return value.slice(root.length).split(path.sep).filter((part) => part.length > 0);
}

async function detectGitDirectory(
  workspaceRoot: string,
  fileSystem: PathPolicyFileSystem,
  maxSymlinks: number,
): Promise<string | null> {
  const dotGit = path.join(workspaceRoot, ".git");
  let stats: Stats;
  try {
    stats = await fileSystem.lstat(dotGit);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw new PathResolutionError(`cannot inspect ${dotGit}`, { cause: error });
  }

  if (stats.isDirectory() || stats.isSymbolicLink()) {
    return resolveStaticTarget(dotGit, workspaceRoot, { fileSystem, maxSymlinks });
  }
  if (!stats.isFile()) return null;
  if (stats.size > MAX_GIT_POINTER_BYTES) {
    throw new PathResolutionError(`Git pointer exceeds ${MAX_GIT_POINTER_BYTES} bytes: ${dotGit}`);
  }

  let contents: string;
  try {
    contents = await fileSystem.readFile(dotGit, "utf8");
  } catch (error) {
    throw new PathResolutionError(`cannot read Git pointer ${dotGit}`, { cause: error });
  }
  const firstLine = contents.split(/\r?\n/u, 1)[0] ?? "";
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(firstLine);
  if (match?.[1] === undefined) return null;
  return resolveStaticTarget(match[1], workspaceRoot, { fileSystem, maxSymlinks });
}

async function tryResolveTarget(
  target: string,
  cwd: string,
  fileSystem: PathPolicyFileSystem,
  maxSymlinks: number,
): Promise<string | null> {
  try {
    return await resolveStaticTarget(target, cwd, { fileSystem, maxSymlinks });
  } catch (error) {
    if (error instanceof PathResolutionError) return null;
    throw error;
  }
}

function extractPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = (input as { path?: unknown }).path;
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DIRECT_PATH_CODE_UNITS &&
    !value.includes("\0")
    ? value
    : null;
}

function mostSpecificContainingRoot(candidate: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => pathIsInside(candidate, root))
    .sort((left, right) => right.length - left.length)[0];
}

function validateProtectedName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    path.isAbsolute(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new TypeError(`protected metadata name must be one path component: ${JSON.stringify(name)}`);
  }
}

function validateMaxSymlinks(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new TypeError("maxSymlinks must be an integer from 1 through 1000");
  }
  return value;
}

function defaultTemporaryRoots(): string[] {
  return process.platform === "win32" ? [tmpdir()] : deduplicate([tmpdir(), "/tmp"]);
}

function deduplicate(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

const NODE_PATH_FILE_SYSTEM: PathPolicyFileSystem = {
  lstat,
  readlink,
  realpath,
  readFile,
};
