import { describe, expect, it } from "vitest";
import {
  CanonicalizationError,
  canonicalJson,
  canonicalizeAction,
  createReviewBinding,
  reviewBindingMatches,
} from "../../src/canonical.ts";

describe("I8/I10 deterministic bounded canonicalization", () => {
  it("sorts every object level and preserves Unicode bytes", () => {
    const left = canonicalJson({ z: "e\u0301", a: { 雪: "☃", b: [true, null, -0] } });
    const right = canonicalJson({ a: { b: [true, null, 0], 雪: "☃" }, z: "e\u0301" });

    expect(left.json).toBe('{"a":{"b":[true,null,0],"雪":"☃"},"z":"é"}');
    expect(left).toEqual(right);
    expect(left.utf8Bytes).toBe(Buffer.byteLength(left.json, "utf8"));
    expect(left.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("accepts repeated non-cyclic references", () => {
    const shared = { value: 1 };
    expect(canonicalJson({ left: shared, right: shared }).json).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );
  });

  it.each([
    ["undefined", undefined, "unsupported"],
    ["function", () => undefined, "unsupported"],
    ["bigint", 1n, "unsupported"],
    ["symbol", Symbol("x"), "unsupported"],
    ["NaN", Number.NaN, "unsupported"],
    ["positive infinity", Number.POSITIVE_INFINITY, "unsupported"],
    ["negative infinity", Number.NEGATIVE_INFINITY, "unsupported"],
    ["Date", new Date(0), "unsupported"],
  ] as const)("rejects %s", (_label, value, code) => {
    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code }),
    );
  });

  it("rejects cycles but does not confuse them with repeated references", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "cycle", path: "$.self" }),
    );
  });

  it("rejects sparse arrays, custom array properties, and symbols", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = true;
    expect(() => canonicalJson(sparse)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "unsupported" }),
    );

    const custom = [1] as unknown[] & { extra?: string };
    custom.extra = "x";
    expect(() => canonicalJson(custom)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "unsupported" }),
    );

    const symbolKeyed: Record<string, unknown> = {};
    Object.defineProperty(symbolKeyed, Symbol("x"), { value: 1, enumerable: true });
    expect(() => canonicalJson(symbolKeyed)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "unsupported" }),
    );
  });

  it("rejects accessors without invoking them", () => {
    let invocations = 0;
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, "danger", {
      enumerable: true,
      get() {
        invocations += 1;
        return "side effect";
      },
    });

    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "unsupported", path: "$.danger" }),
    );
    expect(invocations).toBe(0);
  });

  it("enforces depth, node, and UTF-8 byte budgets", () => {
    expect(() => canonicalJson({ a: { b: true } }, { maxDepth: 1 })).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "depth", path: "$.a.b" }),
    );
    expect(() => canonicalJson([1, 2], { maxNodes: 2 })).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "nodes" }),
    );
    expect(() => canonicalJson("é", { maxBytes: 3 })).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "bytes" }),
    );
    expect(canonicalJson("é", { maxBytes: 4 }).utf8Bytes).toBe(4);
  });

  it("rejects huge scalar and key material before JSON serialization can amplify it", () => {
    const huge = "x".repeat(2_000_000);
    expect(() => canonicalJson(huge)).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ [huge]: true })).toThrow(CanonicalizationError);
  });

  it.each([
    { maxBytes: 0 },
    { maxDepth: -1 },
    { maxNodes: 1.5 },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid limit $maxBytes$maxDepth$maxNodes", (limits) => {
    expect(() => canonicalJson(null, limits)).toThrowError(
      expect.objectContaining<Partial<CanonicalizationError>>({ code: "invalid-limit" }),
    );
  });
});

describe("I8/I9/I14 canonical action and review binding", () => {
  const baseAction = () =>
    canonicalizeAction({
      toolName: "bash",
      arguments: { command: "printf safe" },
      cwd: "/workspace",
      toolMetadata: { description: "shell", schema: { type: "object" } },
    });

  it("binds all action fields", () => {
    const action = baseAction();
    const variants = [
      canonicalizeAction({
        toolName: "write",
        arguments: { command: "printf safe" },
        cwd: "/workspace",
        toolMetadata: { description: "shell", schema: { type: "object" } },
      }),
      canonicalizeAction({
        toolName: "bash",
        arguments: { command: "printf changed" },
        cwd: "/workspace",
        toolMetadata: { description: "shell", schema: { type: "object" } },
      }),
      canonicalizeAction({
        toolName: "bash",
        arguments: { command: "printf safe" },
        cwd: "/other",
        toolMetadata: { description: "shell", schema: { type: "object" } },
      }),
      canonicalizeAction({
        toolName: "bash",
        arguments: { command: "printf safe" },
        cwd: "/workspace",
        toolMetadata: { description: "changed", schema: { type: "object" } },
      }),
    ];

    for (const variant of variants) expect(variant.sha256).not.toBe(action.sha256);
  });

  it("matches only the exact action and captured policy state", () => {
    const input = {
      action: baseAction(),
      globalRevision: 4,
      sessionRevision: 7,
      backend: "sandboxed" as const,
      sessionId: "session-a",
    };
    const binding = createReviewBinding(input);

    expect(reviewBindingMatches(binding, input)).toBe(true);
    expect(reviewBindingMatches(binding, { ...input, action: canonicalizeAction({
      toolName: "bash",
      arguments: { command: "changed" },
      cwd: "/workspace",
      toolMetadata: {},
    }) })).toBe(false);
    expect(reviewBindingMatches(binding, { ...input, globalRevision: 5 })).toBe(false);
    expect(reviewBindingMatches(binding, { ...input, sessionRevision: 8 })).toBe(false);
    expect(reviewBindingMatches(binding, { ...input, backend: "review-only" })).toBe(false);
    expect(reviewBindingMatches(binding, { ...input, sessionId: "session-b" })).toBe(false);
  });

  it("binds a maximum-sized action by digest without duplicating its payload", () => {
    const action = canonicalizeAction({
      toolName: "custom",
      arguments: { payload: "x".repeat(60_000) },
      cwd: "/workspace",
      toolMetadata: null,
    });
    const binding = createReviewBinding({
      action,
      globalRevision: 0,
      sessionRevision: 0,
      backend: "review-only",
      sessionId: "s",
    });

    expect(binding.json).not.toContain("x".repeat(100));
    expect(binding.actionSha256).toBe(action.sha256);
  });

  it("rejects invalid action and binding identity fields", () => {
    expect(() => canonicalizeAction({ toolName: "", arguments: {}, cwd: "/x", toolMetadata: {} }))
      .toThrow(CanonicalizationError);
    expect(() => canonicalizeAction({ toolName: "x", arguments: {}, cwd: "", toolMetadata: {} }))
      .toThrow(CanonicalizationError);
    expect(() => createReviewBinding({
      action: baseAction(),
      globalRevision: -1,
      sessionRevision: 0,
      backend: "sandboxed",
      sessionId: "s",
    })).toThrow(TypeError);
    expect(() => createReviewBinding({
      action: baseAction(),
      globalRevision: 0,
      sessionRevision: 0,
      backend: "sandboxed",
      sessionId: "",
    })).toThrow(CanonicalizationError);
  });
});
