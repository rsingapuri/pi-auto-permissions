import {
  SandboxManager,
  getWslVersion,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { SandboxHost, SandboxRuntimePort } from "./types.ts";

/** Production-only adapter. It exposes no SRT ask callback. */
export function createSrtRuntimePort(): SandboxRuntimePort {
  return {
    isSupportedPlatform: () => SandboxManager.isSupportedPlatform(),
    checkDependencies: () => SandboxManager.checkDependencies(),
    initialize: async (config: SandboxRuntimeConfig) => {
      await SandboxManager.initialize(config, undefined, false);
    },
    wrap: (command, shell, signal) =>
      SandboxManager.wrapWithSandbox(command, shell, undefined, signal),
    cleanupAfterCommand: () => SandboxManager.cleanupAfterCommand(),
    reset: () => SandboxManager.reset(),
  };
}

export function detectSandboxHost(): SandboxHost {
  const wslVersion = getWslVersion();
  return wslVersion === undefined
    ? { platform: process.platform }
    : { platform: process.platform, wslVersion };
}
