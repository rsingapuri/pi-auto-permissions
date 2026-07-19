import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_CONFIG,
  THINKING_LEVELS,
  assertRevision,
  checkpointSession,
  cloneGlobalConfig,
  createSessionState,
  effectiveMode,
  isPermissionMode,
  isModelThinkingLevel,
  nextRevision,
  reviewerSelectionsEqual,
  setRequestedMode,
  setSessionAlive,
  setSessionBackend,
} from "../../src/domain.ts";
import type {
  EffectiveMode,
  GlobalConfig,
  GlobalState,
  PermissionMode,
  ReviewerSelection,
  SessionState,
} from "../../src/domain.ts";

const REVIEWER: ReviewerSelection = {
  provider: "example",
  modelId: "reviewer-1",
  thinkingLevel: "high",
};

function valid(overrides: Partial<GlobalConfig> = {}): GlobalState {
  return {
    health: "valid",
    config: { ...DEFAULT_GLOBAL_CONFIG, ...overrides },
  };
}

function session(requestedMode: PermissionMode): SessionState {
  return { requestedMode, revision: 0, backend: "sandboxed", alive: true };
}

describe("I1/I2 effective-mode truth table", () => {
  it.each([
    [valid({ enabled: false, reviewer: REVIEWER }), "auto", "disabled"],
    [valid({ enabled: false, reviewer: REVIEWER }), "unrestricted", "disabled"],
    [valid({ enabled: false, reviewer: null }), "auto", "disabled"],
    [valid({ enabled: true, reviewer: REVIEWER }), "auto", "auto"],
    [valid({ enabled: true, reviewer: REVIEWER }), "unrestricted", "unrestricted"],
    [valid({ enabled: true, reviewer: null }), "auto", "unrestricted-unavailable"],
    [valid({ enabled: true, reviewer: null }), "unrestricted", "unrestricted"],
    [{ health: "missing", config: cloneGlobalConfig(DEFAULT_GLOBAL_CONFIG) }, "auto", "unrestricted-unavailable"],
    [{ health: "missing", config: cloneGlobalConfig(DEFAULT_GLOBAL_CONFIG) }, "unrestricted", "unrestricted"],
    [{ health: "fault", error: "bad config" }, "auto", "fault"],
    [{ health: "fault", error: "bad config" }, "unrestricted", "unrestricted"],
  ] satisfies readonly [GlobalState, PermissionMode, EffectiveMode][])(
    "$0 with requested $1 becomes $2",
    (global, mode, expected) => {
      expect(effectiveMode(global, session(mode))).toBe(expected);
    },
  );
});

describe("I1/I3/I14 session initialization and revisions", () => {
  it("starts every fresh runtime in Auto with no inherited backend", () => {
    for (const reason of ["new", "resume", "fork", "clone", "subagent", "independent"] as const) {
      void reason;
      expect(createSessionState({ kind: "fresh" })).toEqual({
        requestedMode: "auto",
        revision: 0,
        backend: null,
        alive: true,
      });
    }
  });

  it("restores requested mode only for reload and invalidates old captures", () => {
    const unrestricted = setRequestedMode(createSessionState(), "unrestricted");
    const checkpoint = checkpointSession(unrestricted);

    expect(createSessionState({ kind: "reload", checkpoint })).toEqual({
      requestedMode: "unrestricted",
      revision: unrestricted.revision + 1,
      backend: null,
      alive: true,
    });
    expect(createSessionState({ kind: "reload" })).toEqual(createSessionState({ kind: "fresh" }));
    expect(createSessionState({ kind: "fresh" }).requestedMode).toBe("auto");
  });

  it("increments on each actual local policy/lifecycle change and not on a no-op", () => {
    const initial = createSessionState();
    const mode = setRequestedMode(initial, "unrestricted");
    const backend = setSessionBackend(mode, "sandboxed");
    const failedBackend = setSessionBackend(backend, "unavailable");
    const stopped = setSessionAlive(failedBackend, false);

    expect(mode.revision).toBe(1);
    expect(backend.revision).toBe(2);
    expect(failedBackend.revision).toBe(3);
    expect(stopped.revision).toBe(4);
    expect(setRequestedMode(mode, "unrestricted")).toBe(mode);
    expect(setSessionBackend(backend, "sandboxed")).toBe(backend);
    expect(setSessionAlive(stopped, false)).toBe(stopped);
  });

  it("rejects malformed runtime values and revision exhaustion", () => {
    expect(isPermissionMode("auto")).toBe(true);
    expect(isPermissionMode("ask")).toBe(false);
    expect(() => createSessionState({
      kind: "reload",
      checkpoint: { requestedMode: "ask" as PermissionMode, revision: 0 },
    })).toThrow(TypeError);
    expect(() => setRequestedMode(createSessionState(), "ask" as PermissionMode)).toThrow(TypeError);
    expect(() => setSessionBackend(createSessionState(), "weakened" as "sandboxed")).toThrow(TypeError);
    expect(() => createSessionState({
      kind: "reload",
      checkpoint: { requestedMode: "auto", revision: Number.MAX_SAFE_INTEGER },
    })).toThrow(RangeError);
    expect(() => nextRevision(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

describe("I2 durable value helpers", () => {
  it("uses exactly Pi's ModelThinkingLevel values", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const level of THINKING_LEVELS) expect(isModelThinkingLevel(level)).toBe(true);
    for (const invalid of ["", "none", "extra-high", 1, null, undefined]) {
      expect(isModelThinkingLevel(invalid)).toBe(false);
    }
  });

  it("compares all reviewer fields and clones nested state", () => {
    expect(reviewerSelectionsEqual(REVIEWER, { ...REVIEWER })).toBe(true);
    expect(reviewerSelectionsEqual(REVIEWER, { ...REVIEWER, provider: "other" })).toBe(false);
    expect(reviewerSelectionsEqual(REVIEWER, { ...REVIEWER, modelId: "other" })).toBe(false);
    expect(reviewerSelectionsEqual(REVIEWER, { ...REVIEWER, thinkingLevel: "low" })).toBe(false);
    expect(reviewerSelectionsEqual(null, null)).toBe(true);
    expect(reviewerSelectionsEqual(REVIEWER, null)).toBe(false);

    const original: GlobalConfig = { ...DEFAULT_GLOBAL_CONFIG, reviewer: { ...REVIEWER } };
    const cloned = cloneGlobalConfig(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.reviewer).not.toBe(original.reviewer);
  });

  it("accepts only non-negative safe integer revisions", () => {
    for (const validRevision of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertRevision(validRevision)).not.toThrow();
    }
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
      expect(() => assertRevision(invalid)).toThrow(TypeError);
    }
  });
});
