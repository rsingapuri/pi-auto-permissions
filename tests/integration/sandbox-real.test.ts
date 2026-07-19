import { createServer, type Server } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProductionSandboxController,
  detectSandboxHost,
  type SandboxController,
} from "../../src/sandbox/index.ts";

const host = detectSandboxHost();
const realSandboxEnabled = process.env.PI_AUTO_PERMISSIONS_REAL_SANDBOX === "1";
const realSandboxPlatform =
  host.platform === "darwin" || (host.platform === "linux" && host.wslVersion !== "1");

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0).reverse()) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe.runIf(realSandboxEnabled && realSandboxPlatform)("real SRT sandbox", () => {
  it(
    "enforces workspace writes, protected state, descendant confinement, and no network",
    async () => {
      const originalCwd = process.cwd();
      const workspace = trackedTemporaryDirectory(
        originalCwd,
        ".pi-auto-permissions-srt-workspace-",
      );
      const outside = trackedTemporaryDirectory(
        originalCwd,
        ".pi-auto-permissions-srt-outside-",
      );
      const durableState = join(workspace, "durable-global-state");
      for (const name of [".git", ".agents", ".codex", ".pi"]) {
        mkdirSync(join(workspace, name));
      }
      mkdirSync(durableState);

      let controller: SandboxController | undefined;
      let server: Server | undefined;
      try {
        // Pi can resume a session whose cwd differs from the Node process cwd.
        // Every extension policy path is absolute, so this is a supported
        // production case rather than a reason to lose containment.
        expect(workspace).not.toBe(originalCwd);
        controller = createProductionSandboxController({
          cwd: workspace,
          additionalDenyWrite: [durableState],
        });

        const startup = await controller.start();
        expect(startup, JSON.stringify(startup)).toMatchObject({ kind: "sandboxed" });

        const allowedFile = join(workspace, "allowed.txt");
        const allowed = await execute(
          controller,
          `printf %s ${shellQuote("allowed")} > ${shellQuote(allowedFile)}`,
          workspace,
        );
        expect(allowed.exitCode, allowed.output).toBe(0);
        expect(readFileSync(allowedFile, "utf8")).toBe("allowed");

        const allowedTempDirectory = trackedTemporaryDirectory(
          tmpdir(),
          "pi-auto-permissions-srt-allowed-temp-",
        );
        const allowedTempFile = join(allowedTempDirectory, "allowed.txt");
        const allowedTemp = await execute(
          controller,
          `printf %s ${shellQuote("temp-allowed")} > ${shellQuote(allowedTempFile)}`,
          workspace,
        );
        expect(allowedTemp.exitCode, allowedTemp.output).toBe(0);
        expect(readFileSync(allowedTempFile, "utf8")).toBe("temp-allowed");

        for (const name of [".git", ".agents", ".codex", ".pi"]) {
          const protectedFile = join(workspace, name, "blocked.txt");
          const protectedResult = await execute(
            controller,
            `printf %s ${shellQuote("denied")} > ${shellQuote(protectedFile)}`,
            workspace,
          );
          expect(protectedResult.exitCode, protectedResult.output).not.toBe(0);
          expect(existsSync(protectedFile)).toBe(false);
        }

        const durableFile = join(durableState, "blocked.txt");
        const durableResult = await execute(
          controller,
          `printf %s ${shellQuote("denied")} > ${shellQuote(durableFile)}`,
          workspace,
        );
        expect(durableResult.exitCode, durableResult.output).not.toBe(0);
        expect(existsSync(durableFile)).toBe(false);

        const outsideFile = join(outside, "blocked.txt");
        const descendantScript = `sh -c ${shellQuote(
          `printf %s ${shellQuote("denied")} > ${shellQuote(outsideFile)}`,
        )}`;
        const descendant = await execute(
          controller,
          `sh -c ${shellQuote(descendantScript)}`,
          workspace,
        );
        expect(descendant.exitCode, descendant.output).not.toBe(0);
        expect(existsSync(outsideFile)).toBe(false);

        const symlinkEscape = join(workspace, "outside-alias");
        symlinkSync(outside, symlinkEscape, "dir");
        const symlinkFile = join(symlinkEscape, "symlink-blocked.txt");
        const symlinkResult = await execute(
          controller,
          `printf %s denied > ${shellQuote(symlinkFile)}`,
          workspace,
        );
        expect(symlinkResult.exitCode, symlinkResult.output).not.toBe(0);
        expect(existsSync(join(outside, "symlink-blocked.txt"))).toBe(false);

        const substitutionFile = join(outside, "substitution-blocked.txt");
        await execute(
          controller,
          `value=$(printf %s denied > ${shellQuote(substitutionFile)}; printf x); printf %s "$value"`,
          workspace,
        );
        expect(existsSync(substitutionFile)).toBe(false);

        const interpreterFile = join(outside, "interpreter-blocked.txt");
        const interpreterScript = [
          "const fs = require('node:fs')",
          `fs.writeFileSync(${JSON.stringify(interpreterFile)}, 'denied')`,
        ].join(";");
        const interpreter = await execute(
          controller,
          `${shellQuote(process.execPath)} -e ${shellQuote(interpreterScript)}`,
          workspace,
        );
        expect(interpreter.exitCode, interpreter.output).not.toBe(0);
        expect(existsSync(interpreterFile)).toBe(false);

        let acceptedConnections = 0;
        server = createServer((socket) => {
          acceptedConnections += 1;
          socket.destroy();
        });
        const port = await listenLocal(server);
        const networkScript = [
          "const net = require('node:net')",
          `const socket = net.connect(${String(port)}, '127.0.0.1')`,
          "socket.once('connect', () => process.exit(0))",
          "socket.once('error', () => process.exit(23))",
          "setTimeout(() => process.exit(24), 1500)",
        ].join(";");
        const network = await execute(
          controller,
          `${shellQuote(process.execPath)} -e ${shellQuote(networkScript)}`,
          workspace,
        );
        expect(network.exitCode, network.output).not.toBe(0);
        expect(acceptedConnections).toBe(0);
      } finally {
        await controller?.shutdown().catch(() => undefined);
        await closeServer(server);
        expect(process.cwd()).toBe(originalCwd);
      }
    },
    30_000,
  );
});

async function execute(
  controller: SandboxController,
  command: string,
  cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
  const chunks: Buffer[] = [];
  const result = await controller.operations.exec(command, cwd, {
    onData: (chunk) => chunks.push(Buffer.from(chunk)),
  });
  return { ...result, output: Buffer.concat(chunks).toString("utf8") };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function trackedTemporaryDirectory(parent: string, prefix: string): string {
  const path = mkdtempSync(join(parent, prefix));
  cleanupPaths.push(path);
  return path;
}

function listenLocal(server: Server): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectPromise(new Error("Local test server did not receive a TCP port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else rejectPromise(error);
    });
  });
}
