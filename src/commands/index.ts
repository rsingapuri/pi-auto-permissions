import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  isModelThinkingLevel,
  type PermissionMode,
  type ReviewerSelection,
} from "../domain.js";

type MaybePromise<T> = T | Promise<T>;

export type PermissionCommandSnapshot =
  | { health: "healthy"; reviewer: ReviewerSelection | null }
  | { health: "fault"; error: string };

/**
 * The command layer deliberately knows nothing about files, sessions, or the
 * enforcement runtime. In particular, setReviewerAndAuto is one host-level
 * semantic operation: the command layer never exposes a partially selected
 * reviewer tuple and never switches the session before that tuple is durable.
 */
export interface PermissionCommandsHost {
  readSnapshot(): MaybePromise<PermissionCommandSnapshot>;
  setRequestedMode(mode: PermissionMode, ctx: ExtensionCommandContext): MaybePromise<void>;
  /** Must repair faulted global state before committing the complete tuple. */
  setReviewerAndAuto(selection: ReviewerSelection, ctx: ExtensionCommandContext): MaybePromise<void>;
  /** Must remain callable in faulted global state so the command can repair it. */
  setEnabled(enabled: boolean, ctx: ExtensionCommandContext): MaybePromise<void>;
  updateStatus?(ctx: ExtensionCommandContext): MaybePromise<void>;
}

type CommandRegistrar = Pick<ExtensionAPI, "registerCommand">;

const AUTO = "Auto";
const UNRESTRICTED = "Unrestricted";
const AUTO_UNCONFIGURED = "Auto (unavailable — select /perm-auto-model first)";
const AUTO_FAULTED = "Auto (unavailable — repair permissions settings first)";

const PERM_USAGE = "Usage: /perm auto|unrestricted";
const MODEL_USAGE = "Usage: /perm-auto-model provider/model thinkingLevel";
const ENABLED_USAGE = "Usage: /perm-enabled on|off";

/** Register the complete, intentionally small user-facing command surface. */
export function registerPermissionCommands(
  pi: CommandRegistrar,
  host: PermissionCommandsHost,
): void {
  pi.registerCommand("perm", {
    description: "Set permission mode to Auto or Unrestricted",
    getArgumentCompletions: (prefix) => completeValues(prefix, ["auto", "unrestricted"]),
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      if (args.length > 0) {
        if (args !== "auto" && args !== "unrestricted") {
          ctx.ui.notify(PERM_USAGE, "warning");
          return;
        }

        if (args === "auto" && !(await autoIsAvailable(host, ctx))) return;
        await mutate(
          ctx,
          host,
          () => host.setRequestedMode(args, ctx),
          `Permissions: ${args === "auto" ? AUTO : UNRESTRICTED}.`,
        );
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(PERM_USAGE, "warning");
        return;
      }

      const snapshot = await readSnapshot(host, ctx);
      if (snapshot === undefined) return;
      const autoLabel =
        snapshot.health === "fault"
          ? AUTO_FAULTED
          : snapshot.reviewer === null
            ? AUTO_UNCONFIGURED
            : AUTO;
      const selected = await selectOption(ctx, "Permission mode", [autoLabel, UNRESTRICTED]);
      if (selected === undefined) return;

      if (selected === autoLabel) {
        if (autoLabel !== AUTO) {
          notifyAutoUnavailable(ctx, snapshot);
          return;
        }
        await mutate(ctx, host, () => host.setRequestedMode("auto", ctx), "Permissions: Auto.");
        return;
      }

      if (selected === UNRESTRICTED) {
        await mutate(
          ctx,
          host,
          () => host.setRequestedMode("unrestricted", ctx),
          "Permissions: Unrestricted.",
        );
      }
    },
  });

  pi.registerCommand("perm-auto-model", {
    description: "Select the Auto reviewer model and thinking level",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      let candidate: ReviewerCandidate | undefined;

      if (args.length === 0) {
        if (!ctx.hasUI) {
          ctx.ui.notify(MODEL_USAGE, "warning");
          return;
        }
        candidate = await selectReviewerInteractively(ctx);
      } else {
        const parsed = parseReviewerArgs(args);
        if (parsed === undefined) {
          ctx.ui.notify(MODEL_USAGE, "warning");
          return;
        }
        candidate = parsed;
      }

      if (candidate === undefined) return;
      const validated = await validateReviewer(candidate, ctx);
      if (validated === undefined) return;

      await mutate(
        ctx,
        host,
        () => host.setReviewerAndAuto(validated, ctx),
        `Auto reviewer: ${validated.provider}/${validated.modelId} (thinking: ${validated.thinkingLevel}). Permissions: Auto.`,
      );
    },
  });

  pi.registerCommand("perm-enabled", {
    description: "Enable or disable permission enforcement globally",
    getArgumentCompletions: (prefix) => completeValues(prefix, ["on", "off"]),
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      if (args !== "on" && args !== "off") {
        ctx.ui.notify(ENABLED_USAGE, "warning");
        return;
      }

      const enabled = args === "on";
      await mutate(
        ctx,
        host,
        () => host.setEnabled(enabled, ctx),
        `Permissions ${enabled ? "enabled" : "disabled"} globally.`,
      );
    },
  });
}

interface ReviewerCandidate {
  provider: string;
  modelId: string;
  thinkingLevel: ModelThinkingLevel;
}

function parseReviewerArgs(args: string): ReviewerCandidate | undefined {
  const parts = args.split(/\s+/u);
  if (parts.length !== 2) return undefined;
  const modelSpec = parts[0];
  const thinkingLevel = parts[1];
  if (modelSpec === undefined || thinkingLevel === undefined || !isModelThinkingLevel(thinkingLevel)) {
    return undefined;
  }

  const slash = modelSpec.indexOf("/");
  if (slash <= 0 || slash === modelSpec.length - 1) return undefined;
  return {
    provider: modelSpec.slice(0, slash),
    modelId: modelSpec.slice(slash + 1),
    thinkingLevel,
  };
}

async function selectReviewerInteractively(
  ctx: ExtensionCommandContext,
): Promise<ReviewerCandidate | undefined> {
  let available: Model<string>[];
  try {
    available = ctx.modelRegistry.getAvailable();
  } catch (error) {
    notifyFailure(ctx, "Could not list available reviewer models", error);
    return undefined;
  }

  const byLabel = new Map<string, Model<string>>();
  for (const model of available) byLabel.set(`${model.provider}/${model.id}`, model);
  const labels = [...byLabel.keys()].sort();
  if (labels.length === 0) {
    ctx.ui.notify("No available reviewer models were found.", "warning");
    return undefined;
  }

  const modelLabel = await selectOption(ctx, "Auto reviewer model", labels);
  if (modelLabel === undefined) return undefined;
  const model = byLabel.get(modelLabel);
  if (model === undefined) {
    ctx.ui.notify("The selected reviewer model is no longer available.", "warning");
    return undefined;
  }

  const levels = supportedThinkingLevels(model);
  if (levels.length === 0) {
    ctx.ui.notify(`Reviewer model ${modelLabel} has no supported thinking levels.`, "warning");
    return undefined;
  }
  const thinkingLevel = await selectOption(ctx, "Auto reviewer thinking level", levels);
  if (thinkingLevel === undefined) return undefined;
  if (!isModelThinkingLevel(thinkingLevel) || !levels.includes(thinkingLevel)) {
    ctx.ui.notify("The selected thinking level is no longer supported.", "warning");
    return undefined;
  }

  return { provider: model.provider, modelId: model.id, thinkingLevel };
}

async function validateReviewer(
  candidate: ReviewerCandidate,
  ctx: ExtensionCommandContext,
): Promise<ReviewerSelection | undefined> {
  let model: Model<string> | undefined;
  let available: Model<string>[];
  try {
    model = ctx.modelRegistry.find(candidate.provider, candidate.modelId);
    available = ctx.modelRegistry.getAvailable();
  } catch (error) {
    notifyFailure(ctx, "Could not resolve the reviewer model", error);
    return undefined;
  }

  const display = `${candidate.provider}/${candidate.modelId}`;
  if (model === undefined) {
    ctx.ui.notify(`Reviewer model ${display} does not exist.`, "warning");
    return undefined;
  }
  if (!available.some((item) => item.provider === candidate.provider && item.id === candidate.modelId)) {
    ctx.ui.notify(`Reviewer model ${display} is not available.`, "warning");
    return undefined;
  }

  const levels = supportedThinkingLevels(model);
  if (!levels.includes(candidate.thinkingLevel)) {
    ctx.ui.notify(
      `Thinking level ${candidate.thinkingLevel} is not supported by ${display}. Supported: ${levels.join(", ") || "none"}.`,
      "warning",
    );
    return undefined;
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`Reviewer model ${display} has no usable authentication: ${auth.error}`, "warning");
      return undefined;
    }
  } catch (error) {
    notifyFailure(ctx, `Could not resolve authentication for ${display}`, error);
    return undefined;
  }

  return { ...candidate };
}

function supportedThinkingLevels(model: Model<string>): ModelThinkingLevel[] {
  return [...new Set(getSupportedThinkingLevels(model).filter(isModelThinkingLevel))];
}

async function autoIsAvailable(
  host: PermissionCommandsHost,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const snapshot = await readSnapshot(host, ctx);
  if (snapshot === undefined) return false;
  if (snapshot.health === "healthy" && snapshot.reviewer !== null) return true;
  notifyAutoUnavailable(ctx, snapshot);
  return false;
}

function notifyAutoUnavailable(
  ctx: ExtensionCommandContext,
  snapshot: PermissionCommandSnapshot,
): void {
  if (snapshot.health === "fault") {
    ctx.ui.notify(`Auto is unavailable because permission settings are invalid: ${snapshot.error}`, "warning");
  } else {
    ctx.ui.notify("Auto is unavailable until /perm-auto-model selects a reviewer and thinking level.", "warning");
  }
}

async function readSnapshot(
  host: PermissionCommandsHost,
  ctx: ExtensionCommandContext,
): Promise<PermissionCommandSnapshot | undefined> {
  try {
    return await host.readSnapshot();
  } catch (error) {
    notifyFailure(ctx, "Could not read permission settings", error);
    return undefined;
  }
}

async function mutate(
  ctx: ExtensionCommandContext,
  host: PermissionCommandsHost,
  operation: () => MaybePromise<void>,
  successMessage: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    notifyFailure(ctx, "Permission settings were not changed", error);
    return;
  }

  if (host.updateStatus !== undefined) {
    try {
      await host.updateStatus(ctx);
    } catch (error) {
      notifyFailure(ctx, "Permission settings changed, but status could not be refreshed", error);
    }
  }
  ctx.ui.notify(successMessage, "info");
}

function notifyFailure(ctx: ExtensionCommandContext, prefix: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${prefix}: ${detail}`, "error");
}

async function selectOption(
  ctx: ExtensionCommandContext,
  title: string,
  options: string[],
): Promise<string | undefined> {
  try {
    return await ctx.ui.select(title, options);
  } catch (error) {
    notifyFailure(ctx, "Could not open permission selection", error);
    return undefined;
  }
}

function completeValues(prefix: string, values: readonly string[]) {
  const normalized = prefix.trimStart();
  const filtered = values.filter((value) => value.startsWith(normalized));
  return filtered.length === 0
    ? null
    : filtered.map((value) => ({ value, label: value }));
}
