/*
 * Guardian assessment types are adapted and modified from OpenAI Codex
 * codex-rs/core/src/guardian/mod.rs and prompt.rs at commit
 * 0fb559f0f6e231a88ac02ea002d3ecd248e2b515; Apache-2.0.
 */
import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";

export type GuardianVerdictOutcome = "allow" | "deny";

export interface GuardianVerdict {
	readonly outcome: GuardianVerdictOutcome;
}

/**
 * The exact model selection committed in global state. `thinkingLevel` is Pi's
 * native type so the permission extension cannot invent a parallel setting.
 */
export interface GuardianReviewerSelection {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel: ModelThinkingLevel;
}

/**
 * The backend is part of the approval identity even for non-shell tools.  An
 * unavailable supported-platform sandbox still permits Auto to review direct
 * file and trusted custom tools, so it must be representable here rather than
 * being aliased to another backend.
 */
export type GuardianBackend = "sandboxed" | "review-only" | "unavailable";

/**
 * An immutable snapshot of every value to which an allow verdict is bound.
 * Returning `null` from `getCurrentBinding` means that the session is no longer
 * alive or the action is no longer eligible to execute.
 */
export interface GuardianReviewBinding {
	readonly canonicalAction: string;
	readonly globalRevision: number;
	readonly sessionRevision: number;
	readonly backend: GuardianBackend;
	readonly sessionId: string;
	readonly reviewer: GuardianReviewerSelection;
}

export type GuardianTranscriptItem =
	| {
			readonly kind: "user";
			readonly text: string;
			/** Synthetic context masquerading as a user message never grants authorization. */
			readonly contextual?: boolean;
	  }
	| { readonly kind: "assistant"; readonly text: string }
	| { readonly kind: "tool_call"; readonly toolName: string; readonly text: string }
	| { readonly kind: "tool_result"; readonly toolName?: string; readonly text: string }
	| { readonly kind: "developer" | "system"; readonly text: string };

export type GuardianInvestigationToolName = "read" | "grep" | "find" | "ls";
export type GuardianDecisionToolName = "approve" | "deny";
export type GuardianToolName = GuardianInvestigationToolName | GuardianDecisionToolName;

export interface GuardianInvestigationBudget {
	/** Atomically reserve one investigation round and its calls. */
	reserve(callCount: number): boolean;
}

export interface GuardianModelRequest {
	readonly provider: string;
	readonly modelId: string;
	/** Pi provider option: an explicit `off` selection is represented as undefined. */
	readonly reasoning: ThinkingLevel | undefined;
	readonly systemPrompt: string;
	readonly userPrompt: string;
	/** Fixed read-only tools available only to the independent reviewer. */
	readonly tools: readonly GuardianToolName[];
	/** Shared across all retry attempts for this one review. */
	readonly investigationBudget: GuardianInvestigationBudget;
	/** Revalidate the captured policy binding before each provider turn. */
	readonly isCurrent: () => Promise<boolean>;
	readonly attempt: number;
}

export interface GuardianModelResponse {
	readonly text: string;
}

export type GuardianModelCall = (
	request: GuardianModelRequest,
	signal: AbortSignal,
) => Promise<GuardianModelResponse>;

export type GuardianDenialReason =
	| "model_denied"
	| "invalid_input"
	| "malformed_verdict"
	| "model_error"
	| "internal_error"
	| "timeout"
	| "cancelled"
	| "stale_binding"
	| "queue_exhausted"
	| "circuit_breaker";

export interface GuardianAllowResult {
	readonly outcome: "allow";
	readonly attempts: number;
	readonly binding: GuardianReviewBinding;
	readonly verdict: GuardianVerdict;
	readonly interruptTurn: false;
}

export interface GuardianDenyResult {
	readonly outcome: "deny";
	readonly attempts: number;
	readonly reason: GuardianDenialReason;
	readonly message: string;
	readonly interruptTurn: boolean;
	readonly verdict?: GuardianVerdict;
}

export type GuardianReviewResult = GuardianAllowResult | GuardianDenyResult;

export interface GuardianReviewInput {
	readonly turnId: string;
	readonly binding: GuardianReviewBinding;
	readonly transcript: readonly GuardianTranscriptItem[];
	readonly retryReason?: string;
	readonly signal?: AbortSignal;
	readonly getCurrentBinding: () =>
		| GuardianReviewBinding
		| null
		| Promise<GuardianReviewBinding | null>;
}
