import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	InMemoryCredentialStore,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	GUARDIAN_MAX_INVESTIGATION_ROUNDS,
	GUARDIAN_TOOLS,
	GuardianModelError,
	type GuardianModelRequest,
} from "../../src/guardian/index.js";
import {
	PI_GUARDIAN_MAX_DECISION_REPROMPTS,
	PI_GUARDIAN_MAX_OUTPUT_TOKENS,
	PI_MODEL_RUNTIME_COMPATIBILITY_VERSION,
	createPiGuardianModelCall,
} from "../../src/pi/model-reviewer.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "guardian",
		name: "Guardian",
		api: "test-api",
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function response(
	content?: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content:
			content ??
			[{ type: "toolCall", id: "decision", name: "approve", arguments: {} }],
		api: "test-api",
		provider: "test-provider",
		model: "guardian",
		usage: ZERO_USAGE,
		stopReason: content === undefined ? "toolUse" : "stop",
		timestamp: 1,
		...overrides,
	};
}

function request(overrides: Partial<GuardianModelRequest> = {}): GuardianModelRequest {
	return {
		provider: "test-provider",
		modelId: "guardian",
		reasoning: "high",
		systemPrompt: "guardian system",
		userPrompt: "assess this action",
		tools: GUARDIAN_TOOLS,
		investigationBudget: { reserve: () => true },
		isCurrent: async () => true,
		attempt: 1,
		...overrides,
	};
}

interface RuntimeCall {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: {
		readonly signal?: AbortSignal;
		readonly maxTokens?: number;
		readonly maxRetries?: number;
		readonly reasoning?: ThinkingLevel;
	};
}

function registryFixture(options: {
	readonly selectedModel?: Model<Api> | undefined;
	readonly auth?: { ok: true } | { ok: false; error: string };
	readonly complete?: (call: RuntimeCall) => Promise<AssistantMessage>;
	readonly includeRuntime?: boolean;
} = {}): {
	readonly registry: ModelRegistry;
	readonly find: ReturnType<typeof vi.fn>;
	readonly auth: ReturnType<typeof vi.fn>;
	readonly complete: ReturnType<typeof vi.fn>;
} {
	const selectedModel = Object.hasOwn(options, "selectedModel")
		? options.selectedModel
		: model();
	const find = vi.fn(() => selectedModel);
	const auth = vi.fn(async () => options.auth ?? { ok: true as const });
	const complete = vi.fn(
		async (selected: Model<Api>, context: Context, callOptions: RuntimeCall["options"]) =>
			options.complete?.({ model: selected, context, options: callOptions }) ?? response(),
	);
	const value: Record<string, unknown> = {
		find,
		getApiKeyAndHeaders: auth,
	};
	if (options.includeRuntime !== false) value.runtime = { completeSimple: complete };
	return {
		registry: value as unknown as ModelRegistry,
		find,
		auth,
		complete,
	};
}

async function expectPermanentFailure(operation: Promise<unknown>, text: string): Promise<void> {
	await expect(operation).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof GuardianModelError &&
			error.retryable === false &&
			error.message.includes(text),
	);
}

describe("Pi Guardian model adapter", () => {
	it("pins the deliberately narrow private-runtime compatibility seam", () => {
		expect(PI_MODEL_RUNTIME_COMPATIBILITY_VERSION).toBe("0.80.10");
	});

	it("invokes an extension-registered custom provider through Pi's real 0.80.10 runtime", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let observed:
			| { readonly context: Context; readonly options: RuntimeCall["options"] }
			| undefined;
		runtime.registerProvider("custom-guardian", {
			baseUrl: "https://example.invalid",
			apiKey: "test-key",
			api: "custom-guardian-api",
			models: [
				{
					id: "judge",
					name: "Custom Judge",
					reasoning: true,
					thinkingLevelMap: { max: "max" },
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 2_000,
				},
			],
			streamSimple(selected, context, options) {
				observed = { context, options: options ?? {} };
				const stream = createAssistantMessageEventStream();
				const message = response(undefined, {
					api: selected.api,
					provider: selected.provider,
					model: selected.id,
				});
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
				return stream;
			},
		});
		await runtime.refresh({ allowNetwork: false });
		const registry = new ModelRegistry(runtime);

		await expect(
			createPiGuardianModelCall(registry, { now: () => 7 })(
				request({ provider: "custom-guardian", modelId: "judge", reasoning: "max" }),
				new AbortController().signal,
			),
		).resolves.toEqual({ text: '{"outcome":"allow"}' });
		expect(observed?.context.tools?.map((tool) => tool.name)).toEqual(GUARDIAN_TOOLS);
		expect(observed?.context.messages).toEqual([
			{ role: "user", content: "assess this action", timestamp: 7 },
		]);
		expect(observed?.options).toMatchObject({
			reasoning: "max",
			maxTokens: 2_000,
			maxRetries: 0,
		});
	});

	it("uses the exact catalog model, minimal prompt, read-only context, signal, and no provider retries", async () => {
		const seen: RuntimeCall[] = [];
		const fixture = registryFixture({
			complete: async (call) => {
				seen.push(call);
				return response(
					[
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "toolCall", id: "approve-1", name: "approve", arguments: {} },
					],
					{ stopReason: "toolUse" },
				);
			},
		});
		const signal = new AbortController().signal;
		const call = createPiGuardianModelCall(fixture.registry, { now: () => 42 });

		await expect(call(request(), signal)).resolves.toEqual({ text: '{"outcome":"allow"}' });

		expect(fixture.find).toHaveBeenCalledWith("test-provider", "guardian");
		expect(fixture.auth).toHaveBeenCalledWith(model());
		expect(seen).toHaveLength(1);
		expect(seen[0]?.model).toMatchObject({ provider: "test-provider", id: "guardian" });
		expect(seen[0]?.context).toMatchObject({
			systemPrompt: "guardian system",
			messages: [{ role: "user", content: "assess this action", timestamp: 42 }],
		});
		expect(seen[0]?.context.tools?.map((tool) => tool.name)).toEqual(GUARDIAN_TOOLS);
		expect(seen[0]?.context.systemPrompt).not.toContain("schema");
		expect(seen[0]?.options).toEqual({
			signal,
			maxTokens: PI_GUARDIAN_MAX_OUTPUT_TOKENS,
			maxRetries: 0,
			reasoning: "high",
		});
	});

	it("uses decision tools and re-prompts text instead of parsing it", async () => {
		let calls = 0;
		let correction: Message | undefined;
		const fixture = registryFixture({
			complete: async ({ context }) => {
				calls += 1;
				if (calls === 1) return response([{ type: "text", text: '{"outcome":"allow"}' }]);
				correction = context.messages.at(-1);
				return response(
					[{ type: "toolCall", id: "deny-1", name: "deny", arguments: {} }],
					{ stopReason: "toolUse" },
				);
			},
		});

		await expect(
			createPiGuardianModelCall(fixture.registry)(request(), new AbortController().signal),
		).resolves.toEqual({ text: '{"outcome":"deny"}' });
		expect(fixture.complete).toHaveBeenCalledTimes(2);
		expect(correction).toMatchObject({
			role: "user",
			content: expect.stringContaining("approve or deny"),
		});
	});

	it("bounds decision re-prompts when the model never calls a decision tool", async () => {
		const fixture = registryFixture({
			complete: async () => response([{ type: "text", text: "I approve" }]),
		});
		await expectPermanentFailure(
			createPiGuardianModelCall(fixture.registry)(request(), new AbortController().signal),
			"did not call exactly one decision tool",
		);
		expect(fixture.complete).toHaveBeenCalledTimes(PI_GUARDIAN_MAX_DECISION_REPROMPTS + 1);
	});

	it("maps off to no reasoning option while validating exact model support", async () => {
		const selected = model({ reasoning: false });
		let seenOptions: RuntimeCall["options"] | undefined;
		const fixture = registryFixture({
			selectedModel: selected,
			complete: async (call) => {
				seenOptions = call.options;
				return response();
			},
		});
		const call = createPiGuardianModelCall(fixture.registry);

		await expect(call(request({ reasoning: undefined }), new AbortController().signal)).resolves.toEqual({
			text: '{"outcome":"allow"}',
		});
		expect(seenOptions).toEqual({
			signal: expect.any(AbortSignal),
			maxTokens: PI_GUARDIAN_MAX_OUTPUT_TOKENS,
			maxRetries: 0,
		});

		await expectPermanentFailure(
			call(request({ reasoning: "minimal" }), new AbortController().signal),
			"does not support thinking level minimal",
		);
		expect(fixture.complete).toHaveBeenCalledTimes(1);
	});

	it("fails closed before model I/O for a missing or mismatched exact model", async () => {
		const missing = registryFixture({ selectedModel: undefined });
		await expectPermanentFailure(
			createPiGuardianModelCall(missing.registry)(request(), new AbortController().signal),
			"is unavailable",
		);
		expect(missing.auth).not.toHaveBeenCalled();
		expect(missing.complete).not.toHaveBeenCalled();

		const mismatch = registryFixture({
			selectedModel: model({ provider: "other-provider" }),
		});
		await expectPermanentFailure(
			createPiGuardianModelCall(mismatch.registry)(request(), new AbortController().signal),
			"is unavailable",
		);
		expect(mismatch.complete).not.toHaveBeenCalled();
	});

	it("fails closed for missing and throwing authentication", async () => {
		const unavailable = registryFixture({ auth: { ok: false, error: "secret details" } });
		await expectPermanentFailure(
			createPiGuardianModelCall(unavailable.registry)(request(), new AbortController().signal),
			"authentication is unavailable",
		);
		expect(unavailable.complete).not.toHaveBeenCalled();

		const throwing = registryFixture();
		throwing.auth.mockRejectedValueOnce(new Error("credential store failed"));
		await expectPermanentFailure(
			createPiGuardianModelCall(throwing.registry)(request(), new AbortController().signal),
			"authentication is unavailable",
		);
		expect(throwing.complete).not.toHaveBeenCalled();
	});

	it("fails closed when the exact Pi runtime seam is absent, inherited, or incompatible", async () => {
		const absent = registryFixture({ includeRuntime: false });
		await expectPermanentFailure(
			createPiGuardianModelCall(absent.registry)(request(), new AbortController().signal),
			"runtime is unavailable",
		);

		const inheritedFixture = registryFixture({ includeRuntime: false });
		const inherited = Object.create({ runtime: { completeSimple: vi.fn() } }) as Record<
			string,
			unknown
		>;
		inherited.find = inheritedFixture.find;
		inherited.getApiKeyAndHeaders = inheritedFixture.auth;
		await expectPermanentFailure(
			createPiGuardianModelCall(inherited as unknown as ModelRegistry)(
				request(),
				new AbortController().signal,
			),
			"runtime is unavailable",
		);

		const incompatibleFixture = registryFixture({ includeRuntime: false });
		const incompatible = {
			find: incompatibleFixture.find,
			getApiKeyAndHeaders: incompatibleFixture.auth,
			runtime: { completeSimple: "not a function" },
		} as unknown as ModelRegistry;
		await expectPermanentFailure(
			createPiGuardianModelCall(incompatible)(request(), new AbortController().signal),
			"runtime is incompatible",
		);
	});

	it("passes provider failures to Guardian as retryable but treats cancellation as terminal", async () => {
		const failed = registryFixture({
			complete: async () => response([], { stopReason: "error", errorMessage: "overloaded" }),
		});
		await expect(
			createPiGuardianModelCall(failed.registry)(request(), new AbortController().signal),
		).rejects.toSatisfy(
			(error: unknown) => error instanceof GuardianModelError && error.retryable === true,
		);

		const thrown = registryFixture({
			complete: async () => {
				throw new Error("network");
			},
		});
		await expect(
			createPiGuardianModelCall(thrown.registry)(request(), new AbortController().signal),
		).rejects.toSatisfy(
			(error: unknown) => error instanceof GuardianModelError && error.retryable === true,
		);

		thrown.find.mockClear();
		const controller = new AbortController();
		controller.abort();
		await expectPermanentFailure(
			createPiGuardianModelCall(thrown.registry)(request(), controller.signal),
			"was aborted",
		);
		expect(thrown.find).not.toHaveBeenCalled();
	});

	it("does not dispatch a late model request when cancellation lands during auth", async () => {
		const fixture = registryFixture();
		let releaseAuth: (() => void) | undefined;
		fixture.auth.mockImplementationOnce(
			() =>
				new Promise<{ ok: true }>((resolve) => {
					releaseAuth = () => resolve({ ok: true });
				}),
		);
		const controller = new AbortController();
		const operation = createPiGuardianModelCall(fixture.registry)(request(), controller.signal);
		await vi.waitFor(() => expect(releaseAuth).toBeTypeOf("function"));
		controller.abort();
		releaseAuth?.();

		await expectPermanentFailure(operation, "was aborted");
		expect(fixture.complete).not.toHaveBeenCalled();
	});

	it("executes a bounded read-only investigation and returns the subsequent verdict", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guardian-tools-"));
		try {
			await writeFile(join(cwd, "evidence.txt"), "narrow local target\n", "utf8");
			let toolEvidence: string | undefined;
			let calls = 0;
			const fixture = registryFixture({
				complete: async ({ context }) => {
					calls += 1;
					if (calls === 1) {
						return response(
							[
								{
									type: "toolCall",
									id: "read-1",
									name: "read",
									arguments: { path: "evidence.txt" },
								},
							],
							{ stopReason: "toolUse" },
						);
					}
					const result = context.messages.at(-1);
					if (result?.role === "toolResult" && result.content[0]?.type === "text") {
						toolEvidence = result.content[0].text;
					}
					return response();
				},
			});

			await expect(
				createPiGuardianModelCall(fixture.registry, { cwd })(
					request(),
					new AbortController().signal,
				),
			).resolves.toEqual({ text: '{"outcome":"allow"}' });
			expect(fixture.complete).toHaveBeenCalledTimes(2);
			expect(toolEvidence).toContain("narrow local target");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("revalidates the review binding before each provider turn", async () => {
		const fixture = registryFixture({
			complete: async () =>
				response(
					[{ type: "toolCall", id: "list", name: "ls", arguments: { path: "." } }],
					{ stopReason: "toolUse" },
				),
		});
		let checks = 0;
		const guardedRequest = request({
			isCurrent: async () => {
				checks += 1;
				return checks === 1;
			},
		});

		await expectPermanentFailure(
			createPiGuardianModelCall(fixture.registry)(guardedRequest, new AbortController().signal),
			"binding changed",
		);
		expect(fixture.complete).toHaveBeenCalledTimes(1);
	});

	it("never executes tool calls from a token-truncated response", async () => {
		const fixture = registryFixture({
			complete: async () =>
				response(
					[{ type: "toolCall", id: "truncated", name: "read", arguments: { path: "missing" } }],
					{ stopReason: "length" },
				),
		});

		await expect(
			createPiGuardianModelCall(fixture.registry)(request(), new AbortController().signal),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof GuardianModelError &&
				error.retryable === true &&
				error.message.includes("truncated"),
		);
		expect(fixture.complete).toHaveBeenCalledTimes(1);
	});

	it("bounds read-only investigation rounds", async () => {
		let callId = 0;
		const fixture = registryFixture({
			complete: async () => {
				callId += 1;
				return response(
					[{ type: "toolCall", id: `ls-${callId}`, name: "ls", arguments: { path: "." } }],
					{ stopReason: "toolUse" },
				);
			},
		});

		let reservations = 0;
		const boundedRequest = request({
			investigationBudget: {
				reserve: () => {
					reservations += 1;
					return reservations <= GUARDIAN_MAX_INVESTIGATION_ROUNDS;
				},
			},
		});
		await expectPermanentFailure(
			createPiGuardianModelCall(fixture.registry)(boundedRequest, new AbortController().signal),
			"exceeded its read-only investigation limit",
		);
		expect(fixture.complete).toHaveBeenCalledTimes(GUARDIAN_MAX_INVESTIGATION_ROUNDS + 1);
	});

	it("returns an error result for an unadvertised tool and rejects response identity mismatches", async () => {
		let calls = 0;
		let unknownToolResult: string | undefined;
		const toolCall = registryFixture({
			complete: async ({ context }) => {
				calls += 1;
				if (calls === 1) {
					return response(
						[{ type: "toolCall", id: "1", name: "bash", arguments: { command: "id" } }],
						{ stopReason: "toolUse" },
					);
				}
				const result = context.messages.at(-1);
				if (result?.role === "toolResult" && result.content[0]?.type === "text") {
					unknownToolResult = result.content[0].text;
				}
				return response();
			},
		});
		await expect(
			createPiGuardianModelCall(toolCall.registry)(request(), new AbortController().signal),
		).resolves.toEqual({ text: '{"outcome":"allow"}' });
		expect(unknownToolResult).toContain("Unknown Guardian investigation tool: bash");

		const mismatch = registryFixture({
			complete: async () => response(undefined, { provider: "other-provider" }),
		});
		await expectPermanentFailure(
			createPiGuardianModelCall(mismatch.registry)(request(), new AbortController().signal),
			"different model",
		);
	});

	it("rejects a non-fixed tool contract in a malformed caller request", async () => {
		const fixture = registryFixture();
		const malformed = {
			...request(),
			tools: [{ name: "danger" }],
		} as unknown as GuardianModelRequest;
		await expectPermanentFailure(
			createPiGuardianModelCall(fixture.registry)(malformed, new AbortController().signal),
			"request is invalid",
		);
		expect(fixture.find).not.toHaveBeenCalled();
	});
});
