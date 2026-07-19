import { createHash } from "node:crypto";
import type { EnforcementBackend } from "./domain.ts";
import { assertRevision } from "./domain.ts";

export const DEFAULT_CANONICAL_LIMITS: Readonly<CanonicalLimits> = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
});

export interface CanonicalLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export type CanonicalErrorCode =
  | "unsupported"
  | "cycle"
  | "depth"
  | "nodes"
  | "bytes"
  | "invalid-limit";

export class CanonicalizationError extends Error {
  readonly code: CanonicalErrorCode;
  readonly path: string;

  constructor(code: CanonicalErrorCode, message: string, path = "$") {
    super(`${message} at ${path}`);
    this.name = "CanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

export interface CanonicalDocument {
  json: string;
  utf8Bytes: number;
  sha256: string;
}

export interface ActionInput {
  toolName: string;
  arguments: unknown;
  cwd: string;
  toolMetadata: unknown;
}

export interface CanonicalAction extends CanonicalDocument {
  readonly kind: "canonical-action";
}

export interface ReviewBindingInput {
  action: CanonicalAction;
  globalRevision: number;
  sessionRevision: number;
  backend: EnforcementBackend;
  sessionId: string;
}

export interface ReviewBinding extends CanonicalDocument {
  readonly kind: "review-binding";
  readonly actionSha256: string;
  readonly globalRevision: number;
  readonly sessionRevision: number;
  readonly backend: EnforcementBackend;
  readonly sessionId: string;
}

export function canonicalJson(value: unknown, limits: Partial<CanonicalLimits> = {}): CanonicalDocument {
  const resolvedLimits = normalizeLimits(limits);
  const state: EncodingState = {
    limits: resolvedLimits,
    active: new WeakSet<object>(),
    nodes: 0,
    bytes: 0,
    chunks: [],
  };

  encode(value, "$", 0, state);
  const json = state.chunks.join("");
  return {
    json,
    utf8Bytes: state.bytes,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

export function canonicalizeAction(
  input: Readonly<ActionInput>,
  limits: Partial<CanonicalLimits> = {},
): CanonicalAction {
  if (typeof input.toolName !== "string" || input.toolName.length === 0) {
    throw new CanonicalizationError("unsupported", "toolName must be a non-empty string", "$.toolName");
  }
  if (typeof input.cwd !== "string" || input.cwd.length === 0) {
    throw new CanonicalizationError("unsupported", "cwd must be a non-empty string", "$.cwd");
  }

  const document = canonicalJson(
    {
      arguments: input.arguments,
      cwd: input.cwd,
      toolMetadata: input.toolMetadata,
      toolName: input.toolName,
    },
    limits,
  );

  return { kind: "canonical-action", ...document };
}

export function createReviewBinding(
  input: Readonly<ReviewBindingInput>,
  limits: Partial<CanonicalLimits> = {},
): ReviewBinding {
  assertRevision(input.globalRevision, "global revision");
  assertRevision(input.sessionRevision, "session revision");
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new CanonicalizationError("unsupported", "sessionId must be a non-empty string", "$.sessionId");
  }

  const document = canonicalJson(
    {
      actionSha256: input.action.sha256,
      backend: input.backend,
      globalRevision: input.globalRevision,
      sessionId: input.sessionId,
      sessionRevision: input.sessionRevision,
    },
    limits,
  );

  return {
    kind: "review-binding",
    ...document,
    actionSha256: input.action.sha256,
    globalRevision: input.globalRevision,
    sessionRevision: input.sessionRevision,
    backend: input.backend,
    sessionId: input.sessionId,
  };
}

export function reviewBindingMatches(
  binding: Readonly<ReviewBinding>,
  current: Readonly<ReviewBindingInput>,
): boolean {
  return (
    binding.actionSha256 === current.action.sha256 &&
    binding.globalRevision === current.globalRevision &&
    binding.sessionRevision === current.sessionRevision &&
    binding.backend === current.backend &&
    binding.sessionId === current.sessionId
  );
}

interface EncodingState {
  limits: CanonicalLimits;
  active: WeakSet<object>;
  nodes: number;
  bytes: number;
  chunks: string[];
}

function encode(value: unknown, path: string, depth: number, state: EncodingState): void {
  if (depth > state.limits.maxDepth) {
    throw new CanonicalizationError("depth", `canonical value exceeds depth ${state.limits.maxDepth}`, path);
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new CanonicalizationError("nodes", `canonical value exceeds ${state.limits.maxNodes} nodes`, path);
  }

  if (value === null) return append("null", path, state);
  if (typeof value === "string") {
    // JSON string bytes are never fewer than the source's UTF-16 code units
    // plus its quotes. Reject impossible fits before JSON.stringify can copy
    // an adversarially large tool argument.
    if (value.length + 2 > state.limits.maxBytes - state.bytes) {
      throw new CanonicalizationError(
        "bytes",
        `canonical value exceeds ${state.limits.maxBytes} UTF-8 bytes`,
        path,
      );
    }
    return append(JSON.stringify(value), path, state);
  }
  if (typeof value === "boolean") return append(value ? "true" : "false", path, state);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("unsupported", "non-finite numbers are unsupported", path);
    }
    return append(JSON.stringify(value), path, state);
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError("unsupported", `${typeof value} values are unsupported`, path);
  }

  if (state.active.has(value)) {
    throw new CanonicalizationError("cycle", "cyclic values are unsupported", path);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      encodeArray(value, path, depth, state);
    } else {
      encodeObject(value, path, depth, state);
    }
  } finally {
    state.active.delete(value);
  }
}

function encodeArray(value: unknown[], path: string, depth: number, state: EncodingState): void {
  if (value.length > state.limits.maxNodes - state.nodes) {
    throw new CanonicalizationError("nodes", `canonical value exceeds ${state.limits.maxNodes} nodes`, path);
  }
  const ownKeys = Reflect.ownKeys(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new CanonicalizationError("unsupported", "sparse arrays are unsupported", `${path}[${index}]`);
    }
  }
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key === "symbol" || !isCanonicalArrayIndex(key, value.length)) {
      throw new CanonicalizationError("unsupported", "arrays with custom properties are unsupported", path);
    }
  }

  append("[", path, state);
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) append(",", path, state);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new CanonicalizationError("unsupported", "array accessors are unsupported", `${path}[${index}]`);
    }
    encode(descriptor.value, `${path}[${index}]`, depth + 1, state);
  }
  append("]", path, state);
}

function encodeObject(value: object, path: string, depth: number, state: EncodingState): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError("unsupported", "only plain objects are supported", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalizationError("unsupported", "symbol keys are unsupported", path);
  }

  const keys = Object.keys(value);
  if (keys.length > state.limits.maxNodes - state.nodes) {
    throw new CanonicalizationError("nodes", `canonical value exceeds ${state.limits.maxNodes} nodes`, path);
  }
  // Bound total key material before sort/JSON escaping. Three is the minimum
  // per-key structural cost for two quotes and a colon.
  let minimumKeyBytes = 0;
  for (const key of keys) {
    minimumKeyBytes += key.length + 3;
    if (minimumKeyBytes > state.limits.maxBytes - state.bytes) {
      throw new CanonicalizationError(
        "bytes",
        `canonical value exceeds ${state.limits.maxBytes} UTF-8 bytes`,
        path,
      );
    }
  }
  keys.sort();
  append("{", path, state);
  keys.forEach((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new CanonicalizationError("unsupported", "object accessors are unsupported", childPath(path, key));
    }
    if (index > 0) append(",", path, state);
    append(JSON.stringify(key), childPath(path, key), state);
    append(":", path, state);
    encode(descriptor.value, childPath(path, key), depth + 1, state);
  });
  append("}", path, state);
}

function append(chunk: string, path: string, state: EncodingState): void {
  const bytes = Buffer.byteLength(chunk, "utf8");
  if (state.bytes + bytes > state.limits.maxBytes) {
    throw new CanonicalizationError("bytes", `canonical value exceeds ${state.limits.maxBytes} UTF-8 bytes`, path);
  }
  state.bytes += bytes;
  state.chunks.push(chunk);
}

function normalizeLimits(limits: Partial<CanonicalLimits>): CanonicalLimits {
  const resolved = { ...DEFAULT_CANONICAL_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CanonicalizationError("invalid-limit", `${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}
