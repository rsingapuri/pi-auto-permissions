import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROTECTED_METADATA_NAMES,
  StaticPathPolicy,
  createStaticPathPolicy,
  pathIsInside,
  resolveStaticTarget,
} from "../../src/policy/path-policy.ts";

interface Fixture {
  base: string;
  workspace: string;
  temporary: string;
  outside: string;
}

let fixture: Fixture;
const cleanup: string[] = [];

beforeEach(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "pi-auto-permissions-path-")));
  cleanup.push(base);
  fixture = {
    base,
    workspace: path.join(base, "workspace"),
    temporary: path.join(base, "allowed-temp"),
    outside: path.join(base, "outside"),
  };
  await Promise.all([
    mkdir(fixture.workspace),
    mkdir(fixture.temporary),
    mkdir(fixture.outside),
  ]);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function policy(overrides: Partial<Parameters<typeof StaticPathPolicy.create>[0]> = {}) {
  return StaticPathPolicy.create({
    cwd: fixture.workspace,
    workspaceRoots: [fixture.workspace],
    temporaryRoots: [fixture.temporary],
    ...overrides,
  });
}

describe("I5 static direct-file admission", () => {
  it.each(["read", "grep", "find", "ls"])("admits known read-only tool %s", async (toolName) => {
    const decision = await (await policy()).classify({ toolName, input: { path: "../../anything" } });
    expect(decision).toEqual({ disposition: "admit", reason: "known read-only file tool" });
  });

  it("admits existing and not-yet-created paths within workspace and configured temp roots", async () => {
    const existingDirectory = path.join(fixture.workspace, "existing");
    await mkdir(existingDirectory);
    const classifier = await policy();

    for (const target of [
      "existing/file.txt",
      "new/parents/file.txt",
      path.join(fixture.temporary, "nested", "file.txt"),
    ]) {
      const decision = await classifier.classify({ toolName: "write", input: { path: target } });
      expect(decision.disposition).toBe("admit");
      expect(decision.canonicalTarget).toBe(path.resolve(fixture.workspace, target));
    }
  });

  it("reviews relative escapes, absolute outside paths, and sibling-prefix collisions", async () => {
    const collidingSibling = `${fixture.workspace}-backup`;
    await mkdir(collidingSibling);
    const classifier = await policy();

    for (const target of [
      "../outside/file.txt",
      path.join(fixture.outside, "file.txt"),
      path.join(collidingSibling, "file.txt"),
    ]) {
      const decision = await classifier.classify({ toolName: "edit", input: { path: target } });
      expect(decision.disposition).toBe("review");
      expect(decision.reason).toBe("target is outside writable roots");
    }
  });

  it("reviews every top-level protected metadata tree whether or not it exists", async () => {
    const classifier = await policy();
    for (const name of DEFAULT_PROTECTED_METADATA_NAMES) {
      const decision = await classifier.classify({
        toolName: "write",
        input: { path: path.join(name, "nested", "state") },
      });
      expect(decision.disposition).toBe("review");
      expect(decision.reason).toBe("target is protected metadata");
      expect(decision.protectedRoot).toBe(path.join(fixture.workspace, name));
    }
  });

  it("does not overmatch same-named metadata below the workspace top level", async () => {
    const classifier = await policy();
    for (const name of DEFAULT_PROTECTED_METADATA_NAMES) {
      const decision = await classifier.classify({
        toolName: "write",
        input: { path: path.join("project", name, "ordinary.txt") },
      });
      expect(decision.disposition).toBe("admit");
    }
  });

  it("reviews unknown tools and malformed mutation inputs", async () => {
    const classifier = await policy();
    for (const request of [
      { toolName: "bash", input: { path: "safe.txt" } },
      { toolName: "write", input: null },
      { toolName: "write", input: {} },
      { toolName: "edit", input: { path: "" } },
      { toolName: "edit", input: { path: 4 } },
      { toolName: "edit", input: { path: "bad\0path" } },
    ]) {
      expect((await classifier.classify(request)).disposition).toBe("review");
    }
  });

  it("reviews an overlong mutation path at the static policy input bound", async () => {
    const policy = await StaticPathPolicy.create({
      cwd: fixture.workspace,
      workspaceRoots: [fixture.workspace],
    });
    const decision = await policy.classify({
      toolName: "write",
      input: { path: "x".repeat(32 * 1024 + 1), content: "bounded" },
    });
    expect(decision).toMatchObject({ disposition: "review" });
  });

  it("unconditionally denies extension-owned permission state before model review", async () => {
    const stateRoot = path.join(fixture.workspace, "private-permission-state");
    const classifier = await policy({ deniedRoots: [stateRoot] });
    for (const target of [stateRoot, path.join(stateRoot, "state.json")]) {
      const decision = await classifier.classify({
        toolName: "write",
        input: { path: target, content: "off" },
      });
      expect(decision).toMatchObject({
        disposition: "deny",
        reason: "target is extension-owned permission state",
        deniedRoot: stateRoot,
      });
    }
  });

  it("keeps a missing control-plane path denied if it later becomes a symlink", async () => {
    const stateRoot = path.join(fixture.outside, "future-permission-state");
    const redirectedState = path.join(fixture.workspace, "redirected-state");
    await mkdir(redirectedState);
    const classifier = await policy({ deniedRoots: [stateRoot] });
    await symlink(redirectedState, stateRoot, "dir");

    const decision = await classifier.classify({
      toolName: "write",
      input: { path: path.join(stateRoot, "state.json"), content: "off" },
    });
    expect(decision).toMatchObject({
      disposition: "deny",
      reason: "target is extension-owned permission state",
      deniedRoot: stateRoot,
    });
  });
});

describe("I5/I10 canonical path resolution", () => {
  it("resolves the nearest existing ancestor and normalizes dot segments", async () => {
    await mkdir(path.join(fixture.workspace, "existing", "child"), { recursive: true });
    await expect(resolveStaticTarget("existing/child/../new/file", fixture.workspace)).resolves.toBe(
      path.join(fixture.workspace, "existing", "new", "file"),
    );
    await expect(resolveStaticTarget("../outside/new/file", fixture.workspace)).resolves.toBe(
      path.join(fixture.outside, "new", "file"),
    );
    await expect(resolveStaticTarget("existing/missing/../new/file", fixture.workspace)).rejects.toThrow(
      "unresolved path suffix contains '..'",
    );
  });

  it("resolves existing and dangling symlinks before containment", async () => {
    const safe = path.join(fixture.workspace, "safe");
    const outsideExisting = path.join(fixture.outside, "existing");
    await Promise.all([mkdir(safe), mkdir(outsideExisting)]);
    await Promise.all([
      symlink(safe, path.join(fixture.workspace, "safe-link"), "dir"),
      symlink(outsideExisting, path.join(fixture.workspace, "outside-link"), "dir"),
      symlink(path.join(fixture.outside, "not-created"), path.join(fixture.workspace, "dangling-link"), "dir"),
    ]);
    const classifier = await policy();

    expect((await classifier.classify({
      toolName: "write",
      input: { path: "safe-link/new.txt" },
    })).disposition).toBe("admit");
    for (const target of ["outside-link/new.txt", "dangling-link/new.txt"]) {
      const decision = await classifier.classify({ toolName: "write", input: { path: target } });
      expect(decision.disposition).toBe("review");
      expect(decision.reason).toBe("target is outside writable roots");
    }
  });

  it("applies dot-dot after following a symlink instead of normalizing it away", async () => {
    const outsideDirectory = path.join(fixture.outside, "directory");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, path.join(fixture.workspace, "link"), "dir");
    const classifier = await policy();

    const decision = await classifier.classify({
      toolName: "write",
      input: { path: "link/../escape.txt" },
    });
    expect(decision.disposition).toBe("review");
    expect(decision.canonicalTarget).toBe(path.join(fixture.outside, "escape.txt"));
  });

  it("protects metadata reached through a non-protected symlink alias", async () => {
    const protectedDirectory = path.join(fixture.workspace, ".codex");
    await mkdir(protectedDirectory);
    await symlink(protectedDirectory, path.join(fixture.workspace, "innocent-alias"), "dir");
    const classifier = await policy();

    const decision = await classifier.classify({
      toolName: "edit",
      input: { path: "innocent-alias/config.json" },
    });
    expect(decision.disposition).toBe("review");
    expect(decision.reason).toBe("target is protected metadata");
  });

  it("keeps a missing protected path reviewed if it later becomes a safe-looking symlink", async () => {
    const redirectedMetadata = path.join(fixture.workspace, "ordinary-metadata-target");
    await mkdir(redirectedMetadata);
    const classifier = await policy();
    await symlink(redirectedMetadata, path.join(fixture.workspace, ".pi"), "dir");

    const decision = await classifier.classify({
      toolName: "write",
      input: { path: ".pi/config.json" },
    });
    expect(decision.disposition).toBe("review");
    expect(decision.reason).toBe("target is protected metadata");
    expect(decision.protectedRoot).toBe(path.join(fixture.workspace, ".pi"));
  });

  it("fails closed on symbolic-link cycles and link-depth exhaustion", async () => {
    await symlink("cycle-b", path.join(fixture.workspace, "cycle-a"));
    await symlink("cycle-a", path.join(fixture.workspace, "cycle-b"));
    const classifier = await policy({ maxSymlinks: 2 });

    const decision = await classifier.classify({ toolName: "write", input: { path: "cycle-a/file" } });
    expect(decision.disposition).toBe("review");
    expect(decision.reason).toContain("path exceeds 2 symbolic links");
  });

  it("canonicalizes a symlinked cwd and workspace root", async () => {
    const workspaceAlias = path.join(fixture.base, "workspace-alias");
    await symlink(fixture.workspace, workspaceAlias, "dir");
    const classifier = await createStaticPathPolicy({
      cwd: workspaceAlias,
      workspaceRoots: [workspaceAlias],
      temporaryRoots: [fixture.temporary],
    });

    expect(classifier.cwd).toBe(fixture.workspace);
    expect((await classifier.classify({ toolName: "write", input: { path: "new.txt" } })).canonicalTarget)
      .toBe(path.join(fixture.workspace, "new.txt"));
  });
});

describe("I5 Git and protected-root handling", () => {
  it("protects a resolved Git directory named by a gitdir pointer", async () => {
    const resolvedGitDirectory = path.join(fixture.workspace, "git-data", "worktree");
    await mkdir(resolvedGitDirectory, { recursive: true });
    await writeFile(path.join(fixture.workspace, ".git"), "gitdir: git-data/worktree\n", "utf8");
    const classifier = await policy();

    const decision = await classifier.classify({
      toolName: "write",
      input: { path: "git-data/worktree/index" },
    });
    expect(decision.disposition).toBe("review");
    expect(decision.reason).toBe("target is protected metadata");
    expect(decision.protectedRoot).toBe(resolvedGitDirectory);
  });

  it("protects an explicitly supplied resolved Git directory", async () => {
    const resolvedGitDirectory = path.join(fixture.workspace, "otherwise-writable-git-data");
    await mkdir(resolvedGitDirectory);
    const classifier = await policy({ resolvedGitDirectories: [resolvedGitDirectory] });

    expect((await classifier.classify({
      toolName: "edit",
      input: { path: path.join(resolvedGitDirectory, "config") },
    })).disposition).toBe("review");
  });

  it("protects a .git directory and all descendants", async () => {
    await mkdir(path.join(fixture.workspace, ".git", "objects"), { recursive: true });
    const classifier = await policy();
    const decision = await classifier.classify({
      toolName: "write",
      input: { path: ".git/objects/new-object" },
    });
    expect(decision.disposition).toBe("review");
    expect(decision.protectedRoot).toBe(path.join(fixture.workspace, ".git"));
  });
});

describe("path-policy boundary helpers", () => {
  it("does component-aware containment instead of string-prefix containment", () => {
    expect(pathIsInside(fixture.workspace, fixture.workspace)).toBe(true);
    expect(pathIsInside(path.join(fixture.workspace, "child"), fixture.workspace)).toBe(true);
    expect(pathIsInside(`${fixture.workspace}-backup`, fixture.workspace)).toBe(false);
    expect(pathIsInside(fixture.base, fixture.workspace)).toBe(false);
  });

  it("validates roots, protected names, and symlink bounds", async () => {
    await expect(StaticPathPolicy.create({
      cwd: fixture.workspace,
      workspaceRoots: [],
      temporaryRoots: [fixture.temporary],
    })).rejects.toThrow("at least one workspace root");
    await expect(policy({ protectedMetadataNames: ["nested/name"] })).rejects.toThrow("one path component");
    await expect(policy({ maxSymlinks: 0 })).rejects.toThrow("maxSymlinks");
    await expect(resolveStaticTarget("", fixture.workspace)).rejects.toThrow("must not be empty");
    await expect(resolveStaticTarget("bad\0path", fixture.workspace)).rejects.toThrow("NUL");
  });
});
