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
	GUARDIAN_DECISION_TOOLS,
	GUARDIAN_MAX_TOOL_ENTRY_TOKENS,
	GUARDIAN_TOOLS,
	GuardianModelError,
	truncateGuardianText,
	type GuardianModelCall,
	type GuardianModelRequest,
	type GuardianModelResponse,
} from "../guardian/index.js";
import {
	createGuardianDecisionTools,
	createGuardianInvestigationTools,
} from "./guardian-tools.js";

/**
 * Pi 0.80.10 exposes model lookup and auth through ModelRegistry, but not model
 * invocation. Its own-property `runtime` is therefore the one deliberately
 * isolated compatibility seam in this adapter. Refuse unknown layouts and Pi
 * versions instead of bypassing extension/custom providers through pi-ai's
 * legacy global compatibility dispatcher.
 */
export const PI_MODEL_RUNTIME_COMPATIBILITY_VERSION = "0.80.10";
export const PI_GUARDIAN_MAX_OUTPUT_TOKENS = 8_192;
export const PI_GUARDIAN_MAX_DECISION_REPROMPTS = 2;

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
		request.tools.length !== GUARDIAN_TOOLS.length ||
		request.tools.some((name, index) => name !== GUARDIAN_TOOLS[index]) ||
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

function isDecisionTool(call: ToolCall): boolean {
	return (GUARDIAN_DECISION_TOOLS as readonly string[]).includes(call.name);
}

function hasEmptyArguments(call: ToolCall): boolean {
	return (
		call.arguments !== null &&
		typeof call.arguments === "object" &&
		!Array.isArray(call.arguments) &&
		Object.keys(call.arguments).length === 0
	);
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
	const decisionTools = createGuardianDecisionTools();
	const allTools = [...investigationTools, ...decisionTools];
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
			systemPrompt: request.systemPrompt,
			messages,
			tools: allTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		};
		let decisionReprompts = 0;
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
			const decisionCalls = requestedTools.filter(isDecisionTool);
			if (
				requestedTools.length === 1 &&
				decisionCalls.length === 1 &&
				hasEmptyArguments(decisionCalls[0] as ToolCall)
			) {
				return {
					text:
						decisionCalls[0]?.name === "approve"
							? '{"outcome":"allow"}'
							: '{"outcome":"deny"}',
				};
			}

			if (requestedTools.length === 0 || decisionCalls.length > 0) {
				decisionReprompts += 1;
				if (decisionReprompts > PI_GUARDIAN_MAX_DECISION_REPROMPTS) {
					throw permanentModelError("Pi reviewer did not call exactly one decision tool");
				}
				messages.push(message);
				for (const call of requestedTools) {
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: toolResultText(
							new Error("Call exactly one final decision tool without other tool calls"),
						),
						isError: true,
						timestamp: now(),
					});
				}
				messages.push({
					role: "user",
					content: "Call exactly one final decision tool: approve or deny. Do not answer in text.",
					timestamp: now(),
				});
				continue;
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
