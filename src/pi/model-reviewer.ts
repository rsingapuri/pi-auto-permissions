import type {
	Api,
	Context,
	Model,
	ModelThinkingLevel,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type ModelRegistry,
	type ModelRuntime,
	VERSION as PI_CODING_AGENT_VERSION,
} from "@earendil-works/pi-coding-agent";

import {
	GuardianModelError,
	type GuardianModelCall,
	type GuardianModelRequest,
	type GuardianModelResponse,
} from "../guardian/index.js";

/**
 * Pi 0.80.10 exposes model lookup and auth through ModelRegistry, but not model
 * invocation. Its own-property `runtime` is therefore the one deliberately
 * isolated compatibility seam in this adapter. Refuse unknown layouts and Pi
 * versions instead of bypassing extension/custom providers through pi-ai's
 * legacy global compatibility dispatcher.
 */
export const PI_MODEL_RUNTIME_COMPATIBILITY_VERSION = "0.80.10";
export const PI_GUARDIAN_MAX_OUTPUT_TOKENS = 8_192;

export const PI_GUARDIAN_SCHEMA_PREAMBLE =
	"The final response must validate against this exact JSON Schema (the caller will reject any non-conforming response):";

interface CompatibleModelRuntime {
	completeSimple: ModelRuntime["completeSimple"];
}

export interface PiGuardianModelCallOptions {
	/** Test seam only; request timestamps carry no authorization semantics. */
	readonly now?: () => number;
}

function permanentModelError(message: string, cause?: unknown): GuardianModelError {
	return new GuardianModelError(message, {
		retryable: false,
		...(cause === undefined ? {} : { cause }),
	});
}

function transientModelError(message: string, cause?: unknown): GuardianModelError {
	return new GuardianModelError(message, {
		retryable: true,
		...(cause === undefined ? {} : { cause }),
	});
}

function exactRuntime(registry: ModelRegistry): CompatibleModelRuntime {
	if (PI_CODING_AGENT_VERSION !== PI_MODEL_RUNTIME_COMPATIBILITY_VERSION) {
		throw permanentModelError(
			`Pi ${PI_CODING_AGENT_VERSION} is not supported by the Guardian model-runtime adapter`,
		);
	}

	const descriptor = Object.getOwnPropertyDescriptor(registry, "runtime");
	if (descriptor === undefined || !("value" in descriptor)) {
		throw permanentModelError("Pi model runtime is unavailable");
	}
	const candidate: unknown = descriptor.value;
	if (
		candidate === null ||
		typeof candidate !== "object" ||
		typeof (candidate as Partial<CompatibleModelRuntime>).completeSimple !== "function"
	) {
		throw permanentModelError("Pi model runtime is incompatible");
	}
	return candidate as CompatibleModelRuntime;
}

function assertReviewerRequest(request: GuardianModelRequest): void {
	if (
		typeof request.provider !== "string" ||
		request.provider.length === 0 ||
		typeof request.modelId !== "string" ||
		request.modelId.length === 0 ||
		typeof request.systemPrompt !== "string" ||
		typeof request.userPrompt !== "string" ||
		!Array.isArray(request.tools) ||
		request.tools.length !== 0
	) {
		throw permanentModelError("Guardian model request is invalid");
	}
}

function requestedThinkingLevel(request: GuardianModelRequest): ModelThinkingLevel {
	return request.reasoning ?? "off";
}

function assertThinkingSupported(model: Model<Api>, request: GuardianModelRequest): void {
	const level = requestedThinkingLevel(request);
	if (!getSupportedThinkingLevels(model).includes(level)) {
		throw permanentModelError(
			`Reviewer ${request.provider}/${request.modelId} does not support thinking level ${level}`,
		);
	}
}

function structuredSystemPrompt(request: GuardianModelRequest): string {
	let schema: string | undefined;
	try {
		schema = JSON.stringify(request.outputSchema);
	} catch (error) {
		throw permanentModelError("Guardian output schema is not serializable", error);
	}
	if (typeof schema !== "string" || schema.length === 0) {
		throw permanentModelError("Guardian output schema is unavailable");
	}
	return `${request.systemPrompt.trimEnd()}\n\n${PI_GUARDIAN_SCHEMA_PREAMBLE}\n${schema}\n`;
}

function extractResponseText(
	message: Awaited<ReturnType<ModelRuntime["completeSimple"]>>,
	request: GuardianModelRequest,
): GuardianModelResponse {
	if (message === null || typeof message !== "object") {
		throw transientModelError("Pi reviewer returned a malformed response");
	}
	if (message.provider !== request.provider || message.model !== request.modelId) {
		throw permanentModelError("Pi reviewer returned a response for a different model");
	}
	if (message.stopReason === "aborted") {
		throw permanentModelError("Pi reviewer request was aborted");
	}
	if (message.stopReason === "error") {
		throw transientModelError("Pi reviewer request failed");
	}
	if (!Array.isArray(message.content)) {
		throw transientModelError("Pi reviewer returned malformed content");
	}

	const text: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			text.push(block.text);
			continue;
		}
		if (block.type === "thinking") continue;
		// A reviewer has no tools. A tool call is invalid output even if a provider
		// fabricates one, and is never executed by this adapter.
		throw transientModelError("Pi reviewer attempted an unavailable tool call");
	}
	return { text: text.join("") };
}

/**
 * Adapt Guardian's independent model-call contract to Pi's exact model catalog,
 * auth stack, and provider runtime. All setup mismatches are permanent,
 * fail-closed errors. Provider execution failures are eligible only for
 * Guardian's separate bounded retry policy.
 */
export function createPiGuardianModelCall(
	modelRegistry: ModelRegistry,
	options: PiGuardianModelCallOptions = {},
): GuardianModelCall {
	const now = options.now ?? Date.now;
	return async (
		request: GuardianModelRequest,
		signal: AbortSignal,
	): Promise<GuardianModelResponse> => {
		assertReviewerRequest(request);
		if (signal.aborted) throw permanentModelError("Pi reviewer request was aborted");

		const model = modelRegistry.find(request.provider, request.modelId);
		if (
			model === undefined ||
			model.provider !== request.provider ||
			model.id !== request.modelId
		) {
			throw permanentModelError(
				`Reviewer model ${request.provider}/${request.modelId} is unavailable`,
			);
		}
		assertThinkingSupported(model, request);

		let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
		try {
			auth = await modelRegistry.getApiKeyAndHeaders(model);
		} catch (error) {
			throw permanentModelError(
				`Reviewer authentication is unavailable for ${request.provider}`,
				error,
			);
		}
		if (!auth.ok) {
			throw permanentModelError(
				`Reviewer authentication is unavailable for ${request.provider}`,
			);
		}
		// Auth resolution (notably OAuth refresh) has no AbortSignal in Pi's
		// extension facade. Re-check before provider dispatch so an aggregate
		// Guardian timeout cannot start a late model request after denial.
		if (signal.aborted) throw permanentModelError("Pi reviewer request was aborted");

		const runtime = exactRuntime(modelRegistry);
		const context: Context = {
			systemPrompt: structuredSystemPrompt(request),
			messages: [
				{
					role: "user",
					content: request.userPrompt,
					timestamp: now(),
				},
			],
			tools: [],
		};

		let message: Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
		try {
			message = await runtime.completeSimple(model, context, {
				signal,
				maxTokens: Math.min(model.maxTokens, PI_GUARDIAN_MAX_OUTPUT_TOKENS),
				maxRetries: 0,
				...(request.reasoning === undefined
					? {}
					: { reasoning: request.reasoning as ThinkingLevel }),
			});
		} catch (error) {
			if (signal.aborted) {
				throw permanentModelError("Pi reviewer request was aborted", error);
			}
			throw transientModelError("Pi reviewer request failed", error);
		}
		return extractResponseText(message, request);
	};
}
