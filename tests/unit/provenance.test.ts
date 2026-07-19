import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CODEX_REVISION = "0fb559f0f6e231a88ac02ea002d3ecd248e2b515";
const PI_REVISION = "3da591ab74ab9ab407e72ed882600b2c851fae21";

const VENDORED_CODEX_FILES = {
  "vendor/openai-codex/guardian/policy.md":
    "c2be313e18e1af6f1fce400db338cb9895d3f21cb9f5e31cccb36af02a8e36e6",
  "vendor/openai-codex/guardian/policy_template.md":
    "f41c5bd2900de074a75464fa0c5e73a64e528a9402b9f4b2d511db231becadd2",
  "vendor/openai-codex/NOTICE":
    "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
} as const;

const RUNTIME_DEPENDENCIES = {
  "@anthropic-ai/sandbox-runtime": { version: "0.0.65", license: "Apache-2.0" },
  "proper-lockfile": { version: "4.1.2", license: "MIT" },
  "tree-sitter-bash": { version: "0.25.1", license: "MIT" },
  "web-tree-sitter": { version: "0.25.10", license: "MIT" },
} as const;

const PI_DEVELOPMENT_PACKAGES = {
  "@earendil-works/pi-agent-core": "0.80.10",
  "@earendil-works/pi-ai": "0.80.10",
  "@earendil-works/pi-coding-agent": "0.80.10",
  "@earendil-works/pi-tui": "0.80.10",
} as const;

describe("release provenance", () => {
  it("keeps the exact vendored Codex inputs byte-for-byte pinned", async () => {
    for (const [relativePath, expectedDigest] of Object.entries(VENDORED_CODEX_FILES)) {
      const contents = await readFile(fromRoot(relativePath));
      expect(sha256(contents), relativePath).toBe(expectedDigest);
    }

    const vendorReadme = await text("vendor/openai-codex/README.md");
    expect(vendorReadme).toContain(CODEX_REVISION);
    expect(vendorReadme).toContain("codex-rs/core/src/guardian/policy.md");
    expect(vendorReadme).toContain("codex-rs/core/src/guardian/policy_template.md");
    for (const digest of Object.values(VENDORED_CODEX_FILES)) {
      expect(vendorReadme).toContain(digest);
    }
  });

  it("records the upstream revisions, adaptations, notices, and licenses", async () => {
    const [license, notice, thirdParty, readme, guardianSource, commandSource] =
      await Promise.all([
        text("LICENSE"),
        text("NOTICE"),
        text("THIRD_PARTY_NOTICES.md"),
        text("README.md"),
        text("src/guardian/policy.ts"),
        text("src/policy/dangerous-command.ts"),
      ]);

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(notice).toContain("material adapted from OpenAI Codex");
    expect(notice).toMatch(/Copyright 2025\s+OpenAI/u);

    for (const document of [thirdParty, readme]) {
      expect(document).toContain(CODEX_REVISION);
      expect(document).toContain(PI_REVISION);
      for (const [name, expected] of Object.entries(RUNTIME_DEPENDENCIES)) {
        expect(document).toContain(name);
        expect(document).toContain(expected.version);
      }
    }

    expect(thirdParty).toContain("Copyright (c) 2025 Mario Zechner");
    expect(thirdParty).toContain("Apache License, Version 2.0");
    expect(thirdParty).toContain("MIT License");

    expect(guardianSource).toContain("codex-rs/core/src/guardian/policy.md");
    expect(guardianSource).toContain("codex-rs/core/src/guardian/policy_template.md");
    expect(guardianSource).toContain(CODEX_REVISION);
    expect(guardianSource).toContain("Licensed under Apache-2.0");

    expect(commandSource).toContain(
      "codex-rs/shell-command/src/command_safety/is_dangerous_command.rs",
    );
    expect(commandSource).toContain("codex-rs/shell-command/src/bash.rs");
    expect(commandSource).toContain(CODEX_REVISION);
    expect(commandSource).toContain("Apache-2.0");
  });

  it("pins direct runtime dependencies and the Pi target exactly in the lockfile", async () => {
    const manifest = await json<PackageManifest>("package.json");
    const lock = await json<PackageLock>("package-lock.json");
    const lockRoot = lock.packages[""];
    const expectedRuntimeVersions = Object.fromEntries(
      Object.entries(RUNTIME_DEPENDENCIES).map(([name, value]) => [name, value.version]),
    );

    expect(manifest.license).toBe("Apache-2.0");
    expect(lock.lockfileVersion).toBe(3);
    expect(lockRoot?.license).toBe("Apache-2.0");
    expect(manifest.dependencies).toEqual(expectedRuntimeVersions);
    expect(lockRoot?.dependencies).toEqual(expectedRuntimeVersions);

    for (const [name, expected] of Object.entries(RUNTIME_DEPENDENCIES)) {
      expect(manifest.dependencies?.[name], `package.json dependency ${name}`).toBe(
        expected.version,
      );
      expect(lockRoot?.dependencies?.[name], `lock root dependency ${name}`).toBe(
        expected.version,
      );

      const locked = lock.packages[`node_modules/${name}`];
      expect(locked?.version, `locked package ${name}`).toBe(expected.version);
      expect(locked?.license, `locked license ${name}`).toBe(expected.license);
      expect(locked?.integrity, `locked integrity ${name}`).toMatch(/^sha512-/u);
    }

    for (const [name, version] of Object.entries(PI_DEVELOPMENT_PACKAGES)) {
      expect(manifest.devDependencies?.[name], `package.json Pi target ${name}`).toBe(version);
      expect(lockRoot?.devDependencies?.[name], `lock root Pi target ${name}`).toBe(version);

      const locked = lock.packages[`node_modules/${name}`];
      expect(locked?.version, `locked Pi package ${name}`).toBe(version);
      expect(locked?.license, `locked Pi license ${name}`).toBe("MIT");
      expect(locked?.integrity, `locked Pi integrity ${name}`).toMatch(/^sha512-/u);
    }
  });
});

interface PackageManifest {
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockPackage {
  version?: string;
  license?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
}

function fromRoot(relativePath: string): string {
  return path.join(PROJECT_ROOT, relativePath);
}

async function text(relativePath: string): Promise<string> {
  return readFile(fromRoot(relativePath), "utf8");
}

async function json<T>(relativePath: string): Promise<T> {
  return JSON.parse(await text(relativePath)) as T;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}
