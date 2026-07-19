import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readGlobalConfig } from "../../src/state/config-store.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("I4/I13 real multi-process global state", () => {
  it("serializes independent Pi processes into complete monotonic commits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-permissions-process-race-"));
    cleanup.push(directory);
    const configPath = path.join(directory, "permissions", "state.json");
    const fixture = fileURLToPath(new URL("../fixtures/config-writer.ts", import.meta.url));
    const writerCount = 4;
    const commitsPerWriter = 12;

    await Promise.all(
      Array.from({ length: writerCount }, (_, writer) =>
        runWriter(fixture, configPath, `writer-${String(writer)}`, commitsPerWriter),
      ),
    );

    const state = await readGlobalConfig(configPath);
    expect(state).toMatchObject({
      health: "valid",
      config: { revision: writerCount * commitsPerWriter },
    });
    const serialized = await readFile(configPath, "utf8");
    expect(() => JSON.parse(serialized)).not.toThrow();
    const artifacts = await readdir(path.dirname(configPath));
    expect(artifacts.sort()).toEqual([
      "state.json",
      "state.json.revision",
      "state.json.revision.recovery",
    ]);
  });
});

function runWriter(
  fixture: string,
  configPath: string,
  writerId: string,
  count: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        fixture,
        configPath,
        writerId,
        String(count),
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `writer ${writerId} exited ${String(code)}\n${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}
