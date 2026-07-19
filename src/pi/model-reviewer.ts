import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ModelThinkingLevel,
	TextContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AgentTool as PiAgentTool } from "@earendil-works/pi-agent-core";
import {
	type ModelRegistry,
	type ModelRuntime,
	VERSION as PI_CODING_AGENT_VERSION,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
	GUARDIAN_INVESTIGATION_TOOLS,
	GUARDIAN_MAX_TOOL_ENTRY_TOKENS,
	GuardianModelError,
	truncateGuardianText,
	type GuardianModelCall,
	type GuardianModelRequest,
	type GuardianModelResponse,
} from "../guardian/index.js";
import { createGuardianInvestigationTools } from "./guardian-tools.js";

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
	/** Working directory used to resolve relative read-only investigation paths. */
	readonly cwd?: string;
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
		request.tools.length !== GUARDIAN_INVESTIGATION_TOOLS.length ||
		request.tools.some((name, index) => name !== GUARDIAN_INVESTIGATION_TOOLS[index]) ||
		typeof request.investigationBudget !== "object" ||
		request.investigationBudget === null ||
		typeof request.investigationBudget.reserve !== "function" ||
		typeof request.isCurrent !== "function"
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

function validatedResponse(
	message: Awaited<ReturnType<ModelRuntime["completeSimple"]>>,
	request: GuardianModelRequest,
): AssistantMessage {
	if (message === null || typeof message !== "object" || !Array.isArray(message.content)) {
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
	return message;
}

function responseToolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function finalResponseText(message: AssistantMessage): GuardianModelResponse {
	const text: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") text.push(block.text);
	}
	return { text: text.join("") };
}

function toolResultText(error: unknown): TextContent[] {
	return [
		{
			type: "text",
			text: error instanceof Error ? error.message : String(error),
		},
	];
}

function textOnlyToolContent(
	content: Awaited<ReturnType<PiAgentTool["execute"]>>["content"],
): TextContent[] {
	const text = content
		.map((block) =>
			block.type === "text" ? block.text : "[Image omitted from Guardian investigation]",
		)
		.join("\n");
	return [
		{
			type: "text",
			text: truncateGuardianText(
				text.length > 0 ? text : "<empty tool result>",
				GUARDIAN_MAX_TOOL_ENTRY_TOKENS,
			).text,
		},
	];
}

async function executeInvestigationTool(
	call: ToolCall,
	toolByName: ReadonlyMap<string, PiAgentTool>,
	signal: AbortSignal,
	now: () => number,
): Promise<ToolResultMessage> {
	const tool = toolByName.get(call.name);
	if (tool === undefined) {
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: toolResultText(new Error(`Unknown Guardian investigation tool: ${call.name}`)),
			isError: true,
			timestamp: now(),
		};
	}

	try {
		if (signal.aborted) throw new Error("Guardian investigation was aborted");
		const args = tool.prepareArguments?.(call.arguments) ?? call.arguments;
		if (!Check(tool.parameters, args)) {
			throw new Error(`Invalid arguments for Guardian investigation tool: ${call.name}`);
		}
		const result = await tool.execute(call.id, args, signal);
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: textOnlyToolContent(result.content),
			details: result.details,
			isError: false,
			timestamp: now(),
		};
	} catch (error) {
		return {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: toolResultText(error),
			isError: true,
			timestamp: now(),
		};
	}
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
	const investigationTools = createGuardianInvestigationTools(options.cwd ?? process.cwd());
	const toolByName = new Map<string, PiAgentTool>(
		investigationTools.map((tool) => [tool.name, tool]),
	);
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
		const messages: Message[] = [
			{
				role: "user",
				content: request.userPrompt,
				timestamp: now(),
			},
		];
		const context: Context = {
			systemPrompt: structuredSystemPrompt(request),
			messages,
			tools: investigationTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		};
		for (;;) {
			if (signal.aborted) throw permanentModelError("Pi reviewer request was aborted");
			let current: boolean;
			try {
				current = await request.isCurrent();
			} catch (error) {
				throw permanentModelError("Guardian review binding check failed", error);
			}
			if (!current) throw permanentModelError("Guardian review binding changed");
			if (signal.aborted) throw permanentModelError("Pi reviewer request was aborted");
			let rawMessage: Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
			try {
				rawMessage = await runtime.completeSimple(model, context, {
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

			const message = validatedResponse(rawMessage, request);
			if (message.stopReason === "length") {
				throw transientModelError("Pi reviewer response was truncated");
			}
			const requestedTools = responseToolCalls(message);
			if (requestedTools.length === 0) {
				if (message.stopReason === "toolUse") {
					throw transientModelError("Pi reviewer returned an empty tool-use response");
				}
				return finalResponseText(message);
			}
			if (!request.investigationBudget.reserve(requestedTools.length)) {
				throw permanentModelError("Pi reviewer exceeded its read-only investigation limit");
			}
			messages.push(message);
			for (const call of requestedTools) {
				messages.push(await executeInvestigationTool(call, toolByName, signal, now));
			}
		}
	};
}
