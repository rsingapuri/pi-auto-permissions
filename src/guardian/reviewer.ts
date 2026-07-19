/*
 * Adapted and modified from OpenAI Codex
 * codex-rs/core/src/guardian/review.rs and review_session.rs at commit
 * 0fb559f0f6e231a88ac02ea002d3ecd248e2b515; Apache-2.0.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import {
	GuardianDenialCircuitBreaker,
	type GuardianCircuitBreakerSnapshot,
} from "./circuit-breaker.js";
import { buildGuardianPrompt, type GuardianPrompt } from "./prompt.js";
import type {
	GuardianAllowResult,
	GuardianDenialReason,
	GuardianDenyResult,
	GuardianInvestigationBudget,
	GuardianModelCall,
	GuardianModelRequest,
	GuardianReviewBinding,
	GuardianReviewInput,
	GuardianReviewResult,
	GuardianReviewerSelection,
	GuardianVerdict,
} from "./types.js";
import { GuardianVerdictError, parseGuardianVerdict } from "./verdict.js";

export const GUARDIAN_DENIAL_MESSAGE =
	"Permission denied. This action was not executed. No override will be requested. Choose a materially safer action.";
export const GUARDIAN_REVIEW_FAILURE_MESSAGE =
	"Permission review failed. This action was not executed.";
export const GUARDIAN_OPERATION_ABORTED_MESSAGE = "Operation aborted";
export const GUARDIAN_REVIEW_DEADLINE_MS = 90_000;
export const GUARDIAN_REVIEW_MAX_ATTEMPTS = 3;
export const GUARDIAN_DEFAULT_MAX_CONCURRENT_REVIEWS = 4;
export const GUARDIAN_DEFAULT_MAX_QUEUED_REVIEWS = 32;
export const GUARDIAN_MAX_INVESTIGATION_ROUNDS = 4;
export const GUARDIAN_MAX_INVESTIGATION_CALLS = 8;
const DEFAULT_RETRY_DELAYS_MS = [200, 400] as const;
const SUPPORTED_THINKING_LEVELS = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export const GUARDIAN_INVESTIGATION_TOOLS = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
] as const);
export const GUARDIAN_DECISION_TOOLS = Object.freeze(["approve", "deny"] as const);
export const GUARDIAN_TOOLS = Object.freeze([
	...GUARDIAN_INVESTIGATION_TOOLS,
	...GUARDIAN_DECISION_TOOLS,
] as const);

class GuardianDeadlineError extends Error {
	constructor() {
		super("Guardian aggregate deadline elapsed");
		this.name = "GuardianDeadlineError";
	}
}

class GuardianCancellationError extends Error {
	constructor() {
		super("Guardian review was cancelled");
		this.name = "GuardianCancellationError";
	}
}

/** Provider adapters use this error to opt a failure into the bounded retry set. */
export class GuardianModelError extends Error {
	readonly retryable: boolean;

	constructor(message: string, options: { readonly retryable: boolean; readonly cause?: unknown }) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "GuardianModelError";
		this.retryable = options.retryable;
	}
}

export interface GuardianReviewEngineOptions {
	readonly callModel: GuardianModelCall;
	readonly circuitBreaker?: GuardianDenialCircuitBreaker;
	/** Test seams may shorten, but never lengthen, the normative 90 second deadline. */
	readonly deadlineMs?: number;
	/** Test seams may reduce, but never exceed, the normative three attempts. */
	readonly maxAttempts?: number;
	readonly retryDelaysMs?: readonly number[];
	readonly maxConcurrentReviews?: number;
	readonly maxQueuedReviews?: number;
	readonly now?: () => number;
}

interface PreparedReview {
	readonly turnId: string;
	readonly investigationBudget: GuardianInvestigationBudget;
	readonly binding: GuardianReviewBinding;
	readonly prompt: GuardianPrompt;
	readonly signal: AbortSignal | undefined;
	readonly getCurrentBinding: GuardianReviewInput["getCurrentBinding"];
	readonly deadlineAt: number;
	readonly resolve: (result: GuardianReviewResult) => void;
	settled: boolean;
	queueTimer: ReturnType<typeof setTimeout> | undefined;
	queueAbortListener: (() => void) | undefined;
}

function createInvestigationBudget(): GuardianInvestigationBudget {
	let rounds = 0;
	let calls = 0;
	return Object.freeze({
		reserve(callCount: number): boolean {
			if (!Number.isSafeInteger(callCount) || callCount <= 0) return false;
			if (
				rounds >= GUARDIAN_MAX_INVESTIGATION_ROUNDS ||
				calls + callCount > GUARDIAN_MAX_INVESTIGATION_CALLS
			) {
				return false;
			}
			rounds += 1;
			calls += callCount;
			return true;
		},
	});
}

function snapshotReviewer(reviewer: GuardianReviewerSelection): GuardianReviewerSelection {
	return Object.freeze({
		provider: reviewer.provider,
		modelId: reviewer.modelId,
		thinkingLevel: reviewer.thinkingLevel,
	});
}

function snapshotBinding(binding: GuardianReviewBinding): GuardianReviewBinding {
	return Object.freeze({
		canonicalAction: binding.canonicalAction,
		globalRevision: binding.globalRevision,
		sessionRevision: binding.sessionRevision,
		backend: binding.backend,
		sessionId: binding.sessionId,
		reviewer: snapshotReviewer(binding.reviewer),
	});
}

export function guardianReviewBindingsEqual(
	left: GuardianReviewBinding,
	right: GuardianReviewBinding,
): boolean {
	return (
		left.canonicalAction === right.canonicalAction &&
		left.globalRevision === right.globalRevision &&
		left.sessionRevision === right.sessionRevision &&
		left.backend === right.backend &&
		left.sessionId === right.sessionId &&
		left.reviewer.provider === right.reviewer.provider &&
		left.reviewer.modelId === right.reviewer.modelId &&
		left.reviewer.thinkingLevel === right.reviewer.thinkingLevel
	);
}

function assertPositiveInteger(value: number, label: string, maximum?: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
		throw new RangeError(
			maximum === undefined
				? `${label} must be a positive safe integer`
				: `${label} must be a positive safe integer no greater than ${maximum}`,
		);
	}
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer`);
	}
}

function assertBinding(binding: GuardianReviewBinding): void {
	assertNonNegativeInteger(binding.globalRevision, "globalRevision");
	assertNonNegativeInteger(binding.sessionRevision, "sessionRevision");
	if (
		binding.backend !== "sandboxed" &&
		binding.backend !== "review-only" &&
		binding.backend !== "unavailable"
	) {
		throw new TypeError("Guardian binding has an invalid backend");
	}
	if (
		typeof binding.sessionId !== "string" ||
		binding.sessionId.length === 0 ||
		binding.sessionId.length > 512 ||
		/[\r\n]/u.test(binding.sessionId)
	) {
		throw new TypeError("Guardian binding has an invalid session id");
	}
	if (
		typeof binding.reviewer.provider !== "string" ||
		binding.reviewer.provider.trim().length === 0 ||
		typeof binding.reviewer.modelId !== "string" ||
		binding.reviewer.modelId.trim().length === 0 ||
		!SUPPORTED_THINKING_LEVELS.has(binding.reviewer.thinkingLevel)
	) {
		throw new TypeError("Guardian binding has an invalid reviewer selection");
	}
}

function isRetryableModelError(error: unknown): boolean {
	return error instanceof GuardianModelError && error.retryable;
}

/**
 * Owns all model-review liveness bounds. It never executes the reviewed action
 * and has no UI dependency; the caller may execute only an `allow` result after
 * one final binding comparison at the tool gate.
 */
export class GuardianReviewEngine {
	readonly #callModel: GuardianModelCall;
	readonly #circuitBreaker: GuardianDenialCircuitBreaker;
	readonly #deadlineMs: number;
	readonly #maxAttempts: number;
	readonly #retryDelaysMs: readonly number[];
	readonly #maxConcurrentReviews: number;
	readonly #maxQueuedReviews: number;
	readonly #now: () => number;
	#activeReviews = 0;
	readonly #queue: PreparedReview[] = [];

	constructor(options: GuardianReviewEngineOptions) {
		if (typeof options.callModel !== "function") {
			throw new TypeError("GuardianReviewEngine requires a model-call function");
		}
		const deadlineMs = options.deadlineMs ?? GUARDIAN_REVIEW_DEADLINE_MS;
		const maxAttempts = options.maxAttempts ?? GUARDIAN_REVIEW_MAX_ATTEMPTS;
		const maxConcurrentReviews =
			options.maxConcurrentReviews ?? GUARDIAN_DEFAULT_MAX_CONCURRENT_REVIEWS;
		const maxQueuedReviews = options.maxQueuedReviews ?? GUARDIAN_DEFAULT_MAX_QUEUED_REVIEWS;
		assertPositiveInteger(deadlineMs, "deadlineMs", GUARDIAN_REVIEW_DEADLINE_MS);
		assertPositiveInteger(maxAttempts, "maxAttempts", GUARDIAN_REVIEW_MAX_ATTEMPTS);
		assertPositiveInteger(maxConcurrentReviews, "maxConcurrentReviews");
		if (!Number.isSafeInteger(maxQueuedReviews) || maxQueuedReviews < 0) {
			throw new RangeError("maxQueuedReviews must be a non-negative safe integer");
		}
		const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
		if (
			retryDelaysMs.some(
				(delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > GUARDIAN_REVIEW_DEADLINE_MS,
			)
		) {
			throw new RangeError("Guardian retry delays must be bounded non-negative integers");
		}

		this.#callModel = options.callModel;
		this.#circuitBreaker = options.circuitBreaker ?? new GuardianDenialCircuitBreaker();
		this.#deadlineMs = deadlineMs;
		this.#maxAttempts = maxAttempts;
		this.#retryDelaysMs = [...retryDelaysMs];
		this.#maxConcurrentReviews = maxConcurrentReviews;
		this.#maxQueuedReviews = maxQueuedReviews;
		this.#now = options.now ?? Date.now;
	}

	get load(): { readonly active: number; readonly queued: number } {
		return { active: this.#activeReviews, queued: this.#queue.length };
	}

	clearTurn(turnId: string): void {
		this.#circuitBreaker.clearTurn(turnId);
	}

	isTurnInterrupted(turnId: string): boolean {
		return this.#circuitBreaker.isInterrupted(turnId);
	}

	/** Account for a permission denial decided before Guardian model I/O. */
	recordPermissionDenial(turnId: string): GuardianCircuitBreakerSnapshot {
		return this.#circuitBreaker.recordDenial(turnId);
	}

	/** Account for a statically admitted Auto action between reviewed actions. */
	recordPermissionNonDenial(turnId: string): GuardianCircuitBreakerSnapshot {
		return this.#circuitBreaker.recordNonDenial(turnId);
	}

	circuitBreakerSnapshot(turnId: string): GuardianCircuitBreakerSnapshot {
		return this.#circuitBreaker.snapshot(turnId);
	}

	review(input: GuardianReviewInput): Promise<GuardianReviewResult> {
		const deadlineAt = this.#now() + this.#deadlineMs;
		if (
			typeof input.turnId !== "string" ||
			input.turnId.trim().length === 0 ||
			input.turnId.length > 512
		) {
			return Promise.resolve(this.#deny(input.turnId, "invalid_input", 0, false));
		}
		if (this.#circuitBreaker.isInterrupted(input.turnId)) {
			return Promise.resolve(this.#deny(input.turnId, "circuit_breaker", 0, false));
		}
		if (input.signal?.aborted === true) {
			return Promise.resolve(this.#deny(input.turnId, "cancelled", 0));
		}

		let binding: GuardianReviewBinding;
		let prompt: GuardianPrompt;
		try {
			binding = snapshotBinding(input.binding);
			assertBinding(binding);
			prompt = buildGuardianPrompt({
				sessionId: binding.sessionId,
				transcript: input.transcript,
				canonicalAction: binding.canonicalAction,
				...(input.retryReason === undefined ? {} : { retryReason: input.retryReason }),
			});
		} catch {
			return Promise.resolve(this.#deny(input.turnId, "invalid_input", 0));
		}

		return new Promise<GuardianReviewResult>((resolve) => {
			const prepared: PreparedReview = {
				turnId: input.turnId,
				investigationBudget: createInvestigationBudget(),
				binding,
				prompt,
				signal: input.signal,
				getCurrentBinding: input.getCurrentBinding,
				deadlineAt,
				resolve,
				settled: false,
				queueTimer: undefined,
				queueAbortListener: undefined,
			};
			if (this.#activeReviews < this.#maxConcurrentReviews) {
				this.#begin(prepared);
				return;
			}
			if (this.#queue.length >= this.#maxQueuedReviews) {
				prepared.settled = true;
				resolve(this.#deny(input.turnId, "queue_exhausted", 0));
				return;
			}
			this.#enqueue(prepared);
		});
	}

	#enqueue(prepared: PreparedReview): void {
		this.#queue.push(prepared);
		const remaining = Math.max(0, prepared.deadlineAt - this.#now());
		prepared.queueTimer = setTimeout(() => {
			this.#removeQueued(prepared);
			this.#settle(prepared, this.#deny(prepared.turnId, "timeout", 0));
		}, remaining);
		if (prepared.signal !== undefined) {
			prepared.queueAbortListener = () => {
				this.#removeQueued(prepared);
				this.#settle(prepared, this.#deny(prepared.turnId, "cancelled", 0));
			};
			prepared.signal.addEventListener("abort", prepared.queueAbortListener, { once: true });
		}
	}

	#removeQueued(prepared: PreparedReview): void {
		const index = this.#queue.indexOf(prepared);
		if (index >= 0) this.#queue.splice(index, 1);
	}

	#cleanupQueueWait(prepared: PreparedReview): void {
		if (prepared.queueTimer !== undefined) {
			clearTimeout(prepared.queueTimer);
			prepared.queueTimer = undefined;
		}
		if (prepared.signal !== undefined && prepared.queueAbortListener !== undefined) {
			prepared.signal.removeEventListener("abort", prepared.queueAbortListener);
			prepared.queueAbortListener = undefined;
		}
	}

	#settle(prepared: PreparedReview, result: GuardianReviewResult): void {
		if (prepared.settled) return;
		prepared.settled = true;
		this.#cleanupQueueWait(prepared);
		prepared.resolve(result);
	}

	#begin(prepared: PreparedReview): void {
		if (prepared.settled) return;
		this.#cleanupQueueWait(prepared);
		if (prepared.signal?.aborted === true) {
			this.#settle(prepared, this.#deny(prepared.turnId, "cancelled", 0));
			return;
		}
		if (this.#now() >= prepared.deadlineAt) {
			this.#settle(prepared, this.#deny(prepared.turnId, "timeout", 0));
			return;
		}
		if (this.#circuitBreaker.isInterrupted(prepared.turnId)) {
			this.#settle(prepared, this.#deny(prepared.turnId, "circuit_breaker", 0, false));
			return;
		}

		this.#activeReviews += 1;
		void this.#execute(prepared)
			.then((result) => this.#settle(prepared, result))
			.catch(() => this.#settle(prepared, this.#deny(prepared.turnId, "internal_error", 0)))
			.finally(() => {
				this.#activeReviews -= 1;
				this.#drainQueue();
			});
	}

	#drainQueue(): void {
		while (this.#activeReviews < this.#maxConcurrentReviews && this.#queue.length > 0) {
			const prepared = this.#queue.shift();
			if (prepared !== undefined && !prepared.settled) this.#begin(prepared);
		}
	}

	async #execute(prepared: PreparedReview): Promise<GuardianReviewResult> {
		let attempts = 0;
		for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
			if (this.#circuitBreaker.isInterrupted(prepared.turnId)) {
				return this.#deny(prepared.turnId, "circuit_breaker", attempts, false);
			}

			const preflight = await this.#bindingStatus(prepared);
			if (preflight !== "current") {
				return this.#deny(prepared.turnId, preflight, attempts);
			}

			attempts = attempt;
			let verdict: GuardianVerdict;
			try {
				const controller = new AbortController();
				const request: GuardianModelRequest = Object.freeze({
					provider: prepared.binding.reviewer.provider,
					modelId: prepared.binding.reviewer.modelId,
					reasoning:
						prepared.binding.reviewer.thinkingLevel === "off"
							? undefined
							: prepared.binding.reviewer.thinkingLevel,
					systemPrompt: prepared.prompt.systemPrompt,
					userPrompt: prepared.prompt.userPrompt,
					tools: GUARDIAN_TOOLS,
					investigationBudget: prepared.investigationBudget,
					isCurrent: async () => {
						try {
							const current = await prepared.getCurrentBinding();
							return (
								current !== null &&
								guardianReviewBindingsEqual(prepared.binding, current)
							);
						} catch {
							return false;
						}
					},
					attempt,
				});
				const response = await this.#beforeDeadline(
					Promise.resolve().then(() => this.#callModel(request, controller.signal)),
					prepared.deadlineAt,
					prepared.signal,
					() => controller.abort(),
				);
				verdict = parseGuardianVerdict(response.text);
			} catch (error) {
				const terminalReason = this.#terminalErrorReason(error, prepared);
				if (terminalReason !== null) {
					return this.#deny(prepared.turnId, terminalReason, attempts);
				}
				const retryable = error instanceof GuardianVerdictError || isRetryableModelError(error);
				if (!retryable || attempt >= this.#maxAttempts) {
					return this.#deny(
						prepared.turnId,
						error instanceof GuardianVerdictError ? "malformed_verdict" : "model_error",
						attempts,
					);
				}
				const delayResult = await this.#retryDelay(attempt, prepared);
				if (delayResult !== null) {
					return this.#deny(prepared.turnId, delayResult, attempts);
				}
				continue;
			}

			if (verdict.outcome === "deny") {
				return this.#deny(prepared.turnId, "model_denied", attempts, true, verdict);
			}
			const postflight = await this.#bindingStatus(prepared);
			if (postflight !== "current") {
				return this.#deny(prepared.turnId, postflight, attempts);
			}
			if (this.#circuitBreaker.isInterrupted(prepared.turnId)) {
				return this.#deny(prepared.turnId, "circuit_breaker", attempts, false);
			}
			return this.#allow(prepared.binding, verdict, attempts);
		}

		return this.#deny(prepared.turnId, "internal_error", attempts);
	}

	async #bindingStatus(
		prepared: PreparedReview,
	): Promise<"current" | "stale_binding" | "timeout" | "cancelled" | "internal_error"> {
		try {
			const current = await this.#beforeDeadline(
				Promise.resolve().then(() => prepared.getCurrentBinding()),
				prepared.deadlineAt,
				prepared.signal,
			);
			return current !== null && guardianReviewBindingsEqual(prepared.binding, current)
				? "current"
				: "stale_binding";
		} catch (error) {
			return this.#terminalErrorReason(error, prepared) ?? "internal_error";
		}
	}

	#terminalErrorReason(
		error: unknown,
		prepared: PreparedReview,
	): "timeout" | "cancelled" | null {
		if (error instanceof GuardianCancellationError || prepared.signal?.aborted === true) {
			return "cancelled";
		}
		if (error instanceof GuardianDeadlineError || this.#now() >= prepared.deadlineAt) {
			return "timeout";
		}
		return null;
	}

	async #retryDelay(
		attempt: number,
		prepared: PreparedReview,
	): Promise<"timeout" | "cancelled" | null> {
		const delay = this.#retryDelaysMs[attempt - 1] ?? 0;
		if (delay <= 0) return null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await this.#beforeDeadline(
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, delay);
				}),
				prepared.deadlineAt,
				prepared.signal,
				() => {
					if (timer !== undefined) clearTimeout(timer);
				},
			);
			return null;
		} catch (error) {
			return this.#terminalErrorReason(error, prepared) ?? "timeout";
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	#beforeDeadline<T>(
		operation: Promise<T>,
		deadlineAt: number,
		externalSignal: AbortSignal | undefined,
		onAbort?: () => void,
	): Promise<T> {
		if (externalSignal?.aborted === true) {
			onAbort?.();
			// The operation may already have been created; observe any late rejection.
			void operation.catch(() => undefined);
			return Promise.reject(new GuardianCancellationError());
		}
		const remaining = deadlineAt - this.#now();
		if (remaining <= 0) {
			onAbort?.();
			void operation.catch(() => undefined);
			return Promise.reject(new GuardianDeadlineError());
		}

		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (externalSignal !== undefined) {
					externalSignal.removeEventListener("abort", handleCancellation);
				}
				callback();
			};
			const handleCancellation = (): void => {
				finish(() => {
					onAbort?.();
					reject(new GuardianCancellationError());
				});
			};
			const timer = setTimeout(() => {
				finish(() => {
					onAbort?.();
					reject(new GuardianDeadlineError());
				});
			}, remaining);
			if (externalSignal !== undefined) {
				externalSignal.addEventListener("abort", handleCancellation, { once: true });
			}
			operation.then(
				(value) => finish(() => resolve(value)),
				(error: unknown) => finish(() => reject(error)),
			);
		});
	}

	#allow(
		binding: GuardianReviewBinding,
		verdict: GuardianVerdict,
		attempts: number,
	): GuardianAllowResult {
		return {
			outcome: "allow",
			attempts,
			binding,
			verdict,
			interruptTurn: false,
		};
	}

	#deny(
		turnId: string,
		reason: GuardianDenialReason,
		attempts: number,
		record = true,
		verdict?: GuardianVerdict,
	): GuardianDenyResult {
		const shouldRecord = record && reason !== "cancelled";
		const breaker = shouldRecord
			? this.#circuitBreaker.recordDenial(turnId)
			: this.#circuitBreaker.snapshot(turnId);
		const message =
			reason === "cancelled"
				? GUARDIAN_OPERATION_ABORTED_MESSAGE
				: reason === "model_denied" || reason === "circuit_breaker"
					? GUARDIAN_DENIAL_MESSAGE
					: GUARDIAN_REVIEW_FAILURE_MESSAGE;
		const result = {
			outcome: "deny" as const,
			attempts,
			reason,
			message,
			interruptTurn: breaker.interruptTurn,
		};
		return verdict === undefined ? result : { ...result, verdict };
	}
}
