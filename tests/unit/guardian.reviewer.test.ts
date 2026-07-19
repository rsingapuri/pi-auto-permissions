import { describe, expect, it, vi } from "vitest";

import {
	GUARDIAN_DENIAL_MESSAGE,
	GUARDIAN_INVESTIGATION_TOOLS,
	GUARDIAN_OUTPUT_SCHEMA,
	GuardianModelError,
	GuardianReviewEngine,
	guardianReviewBindingsEqual,
	type GuardianModelCall,
	type GuardianReviewBinding,
	type GuardianReviewInput,
} from "../../src/guardian/index.js";

function binding(overrides: Partial<GuardianReviewBinding> = {}): GuardianReviewBinding {
	return {
		canonicalAction: '{"command":"rm target","cwd":"/work","tool":"bash"}',
		globalRevision: 7,
		sessionRevision: 3,
		backend: "review-only",
		sessionId: "session-1",
		reviewer: { provider: "openai", modelId: "gpt-5.6", thinkingLevel: "high" },
		...overrides,
	};
}

function input(
	captured: GuardianReviewBinding,
	overrides: Partial<GuardianReviewInput> = {},
): GuardianReviewInput {
	return {
		turnId: "turn-1",
		binding: captured,
		transcript: [{ kind: "user", text: "Remove the target" }],
		getCurrentBinding: () => captured,
		...overrides,
	};
}

function allowCall(): GuardianModelCall {
	return async () => ({ text: '{"outcome":"allow"}' });
}

describe("Guardian review binding", () => {
	it("compares model and native Pi thinking level as approval-critical state", () => {
		const original = binding();
		expect(guardianReviewBindingsEqual(original, binding())).toBe(true);
		expect(
			guardianReviewBindingsEqual(
				original,
				binding({
					reviewer: { provider: "openai", modelId: "gpt-5.6", thinkingLevel: "xhigh" },
				}),
			),
		).toBe(false);
		expect(
			guardianReviewBindingsEqual(original, binding({ globalRevision: 8 })),
		).toBe(false);
		expect(
			guardianReviewBindingsEqual(
				original,
				binding({ canonicalAction: '{"command":"rm other","tool":"bash"}' }),
			),
		).toBe(false);
	});

	it("passes the selected model, reasoning, and fixed read-only tools to an independent call", async () => {
		const captured = binding();
		const callModel = vi.fn<GuardianModelCall>(allowCall());
		const engine = new GuardianReviewEngine({ callModel });

		const result = await engine.review(input(captured));

		expect(result.outcome).toBe("allow");
		expect(callModel).toHaveBeenCalledTimes(1);
		const [request] = callModel.mock.calls[0] ?? [];
		expect(request).toMatchObject({
			provider: "openai",
			modelId: "gpt-5.6",
			reasoning: "high",
			attempt: 1,
			outputSchema: GUARDIAN_OUTPUT_SCHEMA,
			tools: GUARDIAN_INVESTIGATION_TOOLS,
		});
		expect(request?.systemPrompt).toContain("available read-only tools");
		expect(request?.userPrompt).toContain(captured.canonicalAction);
	});

	it("maps the durable off thinking selection to an undefined provider reasoning option", async () => {
		const captured = binding({
			reviewer: { provider: "openai", modelId: "gpt-5.6", thinkingLevel: "off" },
		});
		const callModel = vi.fn<GuardianModelCall>(allowCall());
		const engine = new GuardianReviewEngine({ callModel });

		expect(await engine.review(input(captured))).toMatchObject({ outcome: "allow" });
		expect(callModel.mock.calls[0]?.[0]).toHaveProperty("reasoning", undefined);
	});

	it("binds non-shell reviews to an unavailable supported-platform backend", async () => {
		const captured = binding({ backend: "unavailable" });
		const engine = new GuardianReviewEngine({ callModel: allowCall() });
		await expect(engine.review(input(captured))).resolves.toMatchObject({
			outcome: "allow",
			binding: { backend: "unavailable" },
		});
	});

	it("I14 rejects an allow when reasoning level and global revision changed during review", async () => {
		const captured = binding();
		const changed = binding({
			globalRevision: 8,
			reviewer: { provider: "openai", modelId: "gpt-5.6", thinkingLevel: "max" },
		});
		let checks = 0;
		const engine = new GuardianReviewEngine({ callModel: allowCall() });

		const result = await engine.review(
			input(captured, {
				getCurrentBinding: () => {
					checks += 1;
					return checks === 1 ? captured : changed;
				},
			}),
		);

		expect(result).toMatchObject({ outcome: "deny", reason: "stale_binding", attempts: 1 });
	});

	it("I14 rejects a request that is stale before model I/O", async () => {
		const captured = binding();
		const callModel = vi.fn<GuardianModelCall>(allowCall());
		const engine = new GuardianReviewEngine({ callModel });

		const result = await engine.review(
			input(captured, { getCurrentBinding: () => binding({ sessionRevision: 4 }) }),
		);

		expect(result).toMatchObject({ outcome: "deny", reason: "stale_binding", attempts: 0 });
		expect(callModel).not.toHaveBeenCalled();
	});
});

describe("Guardian fail-closed behavior", () => {
	it("I11 returns one fixed terminal denial with no dialog or retry invitation", async () => {
		const captured = binding();
		const callModel = vi.fn<GuardianModelCall>(async () => ({
			text: '{"risk_level":"critical","outcome":"deny","rationale":"destructive"}',
		}));
		const engine = new GuardianReviewEngine({ callModel });

		const result = await engine.review(input(captured));

		expect(result).toMatchObject({
			outcome: "deny",
			reason: "model_denied",
			attempts: 1,
			message: GUARDIAN_DENIAL_MESSAGE,
		});
		expect(callModel).toHaveBeenCalledTimes(1);
		expect(GUARDIAN_DENIAL_MESSAGE.toLowerCase()).not.toContain("ask the user");
		expect(GUARDIAN_DENIAL_MESSAGE.toLowerCase()).not.toContain("retry");
	});

	it("I10 retries malformed output at most three times, then denies", async () => {
		const callModel = vi.fn<GuardianModelCall>(async () => ({ text: "```json\n{}\n```" }));
		const captured = binding();
		const engine = new GuardianReviewEngine({ callModel, retryDelaysMs: [0, 0] });

		const result = await engine.review(input(captured));

		expect(result).toMatchObject({ outcome: "deny", reason: "malformed_verdict", attempts: 3 });
		expect(callModel).toHaveBeenCalledTimes(3);
	});

	it("retries only explicitly transient model errors", async () => {
		const captured = binding();
		const transient = vi
			.fn<GuardianModelCall>()
			.mockRejectedValueOnce(new GuardianModelError("overloaded", { retryable: true }))
			.mockResolvedValueOnce({ text: '{"outcome":"allow"}' });
		const transientEngine = new GuardianReviewEngine({
			callModel: transient,
			retryDelaysMs: [0],
		});
		expect(await transientEngine.review(input(captured))).toMatchObject({
			outcome: "allow",
			attempts: 2,
		});

		const permanent = vi.fn<GuardianModelCall>().mockRejectedValue(new Error("bad auth"));
		const permanentEngine = new GuardianReviewEngine({ callModel: permanent });
		expect(await permanentEngine.review(input(captured))).toMatchObject({
			outcome: "deny",
			reason: "model_error",
			attempts: 1,
		});
		expect(permanent).toHaveBeenCalledTimes(1);
	});

	it("shares one cumulative investigation budget across all retry attempts", async () => {
		const captured = binding();
		const budgets: unknown[] = [];
		const reservations: boolean[] = [];
		const callModel = vi.fn<GuardianModelCall>(async (request) => {
			budgets.push(request.investigationBudget);
			reservations.push(request.investigationBudget.reserve(4));
			return { text: "invalid" };
		});
		const engine = new GuardianReviewEngine({ callModel, retryDelaysMs: [0, 0] });

		expect(await engine.review(input(captured))).toMatchObject({
			outcome: "deny",
			reason: "malformed_verdict",
			attempts: 3,
		});
		expect(budgets).toHaveLength(3);
		expect(budgets.every((budget) => budget === budgets[0])).toBe(true);
		expect(reservations).toEqual([true, true, false]);
	});

	it("I15 applies one aggregate deadline and aborts a hanging reviewer", async () => {
		let observedSignal: AbortSignal | undefined;
		const callModel: GuardianModelCall = (_request, signal) => {
			observedSignal = signal;
			return new Promise(() => undefined);
		};
		const captured = binding();
		const engine = new GuardianReviewEngine({ callModel, deadlineMs: 20 });

		const result = await engine.review(input(captured));

		expect(result).toMatchObject({ outcome: "deny", reason: "timeout", attempts: 1 });
		expect(observedSignal?.aborted).toBe(true);
	});

	it("counts retry backoff inside the aggregate deadline", async () => {
		const captured = binding();
		const callModel = vi.fn<GuardianModelCall>(async () => ({ text: "invalid" }));
		const engine = new GuardianReviewEngine({
			callModel,
			deadlineMs: 20,
			retryDelaysMs: [100],
		});

		const result = await engine.review(input(captured));

		expect(result).toMatchObject({ outcome: "deny", reason: "timeout", attempts: 1 });
		expect(callModel).toHaveBeenCalledTimes(1);
	});

	it("I10 maps cancellation, invalid selection, and binding-check failure to denial", async () => {
		const captured = binding();
		const aborted = new AbortController();
		aborted.abort();
		const engine = new GuardianReviewEngine({ callModel: allowCall() });
		expect(await engine.review(input(captured, { signal: aborted.signal }))).toMatchObject({
			outcome: "deny",
			reason: "cancelled",
			attempts: 0,
		});

		const invalidThinking = binding({
			reviewer: {
				provider: "openai",
				modelId: "gpt-5.6",
				thinkingLevel: "turbo" as never,
			},
		});
		expect(await engine.review(input(invalidThinking))).toMatchObject({
			outcome: "deny",
			reason: "invalid_input",
		});

		expect(
			await engine.review(
				input(captured, {
					turnId: "turn-binding-error",
					getCurrentBinding: () => {
						throw new Error("state unavailable");
					},
				}),
			),
		).toMatchObject({ outcome: "deny", reason: "internal_error", attempts: 0 });
	});
});

describe("Guardian bounded concurrency and denial loops", () => {
	it("I15 bounds active/queued reviews and fails closed on queue exhaustion", async () => {
		const captured = binding();
		const resolvers: Array<(value: { text: string }) => void> = [];
		const callModel = vi.fn<GuardianModelCall>(
			() =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const engine = new GuardianReviewEngine({
			callModel,
			maxConcurrentReviews: 1,
			maxQueuedReviews: 1,
		});

		const first = engine.review(input(captured, { turnId: "turn-a" }));
		await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(1));
		const second = engine.review(input(captured, { turnId: "turn-b" }));
		const third = await engine.review(input(captured, { turnId: "turn-c" }));
		expect(third).toMatchObject({ outcome: "deny", reason: "queue_exhausted", attempts: 0 });
		expect(engine.load).toEqual({ active: 1, queued: 1 });

		resolvers[0]?.({ text: '{"outcome":"allow"}' });
		expect(await first).toMatchObject({ outcome: "allow" });
		await vi.waitFor(() => expect(callModel).toHaveBeenCalledTimes(2));
		resolvers[1]?.({ text: '{"outcome":"allow"}' });
		expect(await second).toMatchObject({ outcome: "allow" });
	});

	it("I16 interrupts after three denied actions and performs no fourth model call", async () => {
		const captured = binding();
		const callModel = vi.fn<GuardianModelCall>(async () => ({ text: '{"outcome":"deny"}' }));
		const engine = new GuardianReviewEngine({ callModel });

		const first = await engine.review(input(captured));
		const second = await engine.review(input(captured));
		const third = await engine.review(input(captured));
		const fourth = await engine.review(input(captured));

		expect(first).toMatchObject({ interruptTurn: false });
		expect(second).toMatchObject({ interruptTurn: false });
		expect(third).toMatchObject({ interruptTurn: true });
		expect(fourth).toMatchObject({
			outcome: "deny",
			reason: "circuit_breaker",
			interruptTurn: true,
		});
		expect(callModel).toHaveBeenCalledTimes(3);
	});

	it("does not reset denials for a provisional allow until the caller finalizes admission", async () => {
		const captured = binding();
		const callModel = vi
			.fn<GuardianModelCall>()
			.mockResolvedValueOnce({ text: '{"outcome":"deny"}' })
			.mockResolvedValueOnce({ text: '{"outcome":"deny"}' })
			.mockResolvedValueOnce({ text: '{"outcome":"allow"}' })
			.mockResolvedValueOnce({ text: '{"outcome":"deny"}' });
		const engine = new GuardianReviewEngine({ callModel });

		await engine.review(input(captured));
		await engine.review(input(captured));
		expect(await engine.review(input(captured))).toMatchObject({ outcome: "allow" });
		expect(engine.circuitBreakerSnapshot("turn-1").consecutiveDenials).toBe(2);

		engine.recordPermissionNonDenial("turn-1");
		expect(await engine.review(input(captured))).toMatchObject({ interruptTurn: false });
		expect(engine.circuitBreakerSnapshot("turn-1").consecutiveDenials).toBe(1);
	});
});
