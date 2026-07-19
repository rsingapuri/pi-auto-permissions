/*
 * Adapted and modified from OpenAI Codex
 * codex-rs/core/src/guardian/prompt.rs at commit
 * 0fb559f0f6e231a88ac02ea002d3ecd248e2b515; Apache-2.0.
 */
import { Buffer } from "node:buffer";

import type {
	GuardianOutputSchema,
	GuardianRiskLevel,
	GuardianUserAuthorization,
	GuardianVerdict,
	GuardianVerdictOutcome,
} from "./types.js";

export const GUARDIAN_MAX_VERDICT_BYTES = 16_384;

const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"] as const);
const AUTHORIZATION_LEVELS = Object.freeze(["unknown", "low", "medium", "high"] as const);
const OUTCOMES = Object.freeze(["allow", "deny"] as const);
const ALLOWED_KEYS = new Set(["risk_level", "user_authorization", "outcome", "rationale"]);

export const GUARDIAN_OUTPUT_SCHEMA: GuardianOutputSchema = Object.freeze({
	type: "object",
	additionalProperties: false,
	properties: Object.freeze({
		risk_level: Object.freeze({ type: "string", enum: RISK_LEVELS }),
		user_authorization: Object.freeze({ type: "string", enum: AUTHORIZATION_LEVELS }),
		outcome: Object.freeze({ type: "string", enum: OUTCOMES }),
		rationale: Object.freeze({ type: "string" }),
	}),
	required: Object.freeze(["outcome"] as const),
});

export type GuardianVerdictErrorCode =
	| "empty"
	| "oversized"
	| "invalid_json"
	| "invalid_shape"
	| "duplicate_field"
	| "unknown_field"
	| "missing_outcome"
	| "invalid_outcome"
	| "invalid_risk_level"
	| "invalid_authorization"
	| "invalid_rationale";

export class GuardianVerdictError extends Error {
	readonly code: GuardianVerdictErrorCode;

	constructor(code: GuardianVerdictErrorCode, message: string) {
		super(message);
		this.name = "GuardianVerdictError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRiskLevel(value: unknown): value is GuardianRiskLevel {
	return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

function isAuthorization(value: unknown): value is GuardianUserAuthorization {
	return typeof value === "string" && (AUTHORIZATION_LEVELS as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is GuardianVerdictOutcome {
	return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

function skipWhitespace(text: string, start: number): number {
	let index = start;
	while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
	return index;
}

function jsonStringEnd(text: string, start: number): number {
	let escaped = false;
	for (let index = start + 1; index < text.length; index += 1) {
		const character = text[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') return index + 1;
	}
	return text.length;
}

/** JSON.parse accepts duplicate members and silently keeps the last one. */
function assertNoDuplicateTopLevelFields(text: string): void {
	let index = skipWhitespace(text, 0);
	if (text[index] !== "{") return;
	index = skipWhitespace(text, index + 1);
	const fields = new Set<string>();
	while (index < text.length && text[index] !== "}") {
		const keyEnd = jsonStringEnd(text, index);
		const field = JSON.parse(text.slice(index, keyEnd)) as string;
		if (fields.has(field)) {
			throw new GuardianVerdictError(
				"duplicate_field",
				`Guardian verdict repeats field: ${field}`,
			);
		}
		fields.add(field);
		index = skipWhitespace(text, keyEnd);
		if (text[index] !== ":") return;
		index += 1;

		let nestedDepth = 0;
		let inString = false;
		let escaped = false;
		for (; index < text.length; index += 1) {
			const character = text[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') {
				inString = true;
				continue;
			}
			if (character === "{" || character === "[") {
				nestedDepth += 1;
				continue;
			}
			if (character === "]") {
				nestedDepth -= 1;
				continue;
			}
			if (character === "}" && nestedDepth > 0) {
				nestedDepth -= 1;
				continue;
			}
			if (nestedDepth === 0 && (character === "," || character === "}")) break;
		}
		if (text[index] === ",") index = skipWhitespace(text, index + 1);
	}
}

/**
 * Parses one complete JSON value and applies the pinned Guardian schema. There
 * is intentionally no fence/prose extraction and no inference of an allow.
 */
export function parseGuardianVerdict(text: string): GuardianVerdict {
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new GuardianVerdictError("empty", "Guardian verdict was empty");
	}
	if (Buffer.byteLength(text, "utf8") > GUARDIAN_MAX_VERDICT_BYTES) {
		throw new GuardianVerdictError("oversized", "Guardian verdict exceeded its size limit");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new GuardianVerdictError("invalid_json", "Guardian verdict was not one JSON value");
	}
	if (!isRecord(parsed)) {
		throw new GuardianVerdictError("invalid_shape", "Guardian verdict must be a JSON object");
	}
	assertNoDuplicateTopLevelFields(text);

	for (const key of Object.keys(parsed)) {
		if (!ALLOWED_KEYS.has(key)) {
			throw new GuardianVerdictError("unknown_field", `Guardian verdict has unknown field: ${key}`);
		}
	}

	if (!Object.hasOwn(parsed, "outcome")) {
		throw new GuardianVerdictError("missing_outcome", "Guardian verdict omitted outcome");
	}
	if (!isOutcome(parsed.outcome)) {
		throw new GuardianVerdictError("invalid_outcome", "Guardian outcome must be allow or deny");
	}
	const outcome = parsed.outcome;

	if (parsed.risk_level !== undefined && !isRiskLevel(parsed.risk_level)) {
		throw new GuardianVerdictError("invalid_risk_level", "Guardian risk_level was invalid");
	}
	if (parsed.user_authorization !== undefined && !isAuthorization(parsed.user_authorization)) {
		throw new GuardianVerdictError(
			"invalid_authorization",
			"Guardian user_authorization was invalid",
		);
	}
	if (parsed.rationale !== undefined && typeof parsed.rationale !== "string") {
		throw new GuardianVerdictError("invalid_rationale", "Guardian rationale must be a string");
	}

	const riskLevel = parsed.risk_level ?? (outcome === "allow" ? "low" : "high");
	const userAuthorization = parsed.user_authorization ?? "unknown";
	const suppliedRationale = parsed.rationale?.trim();
	const rationale =
		suppliedRationale === undefined || suppliedRationale.length === 0
			? outcome === "allow"
				? "Auto-review returned a low-risk allow decision."
				: "Auto-review returned a deny decision without a rationale."
			: suppliedRationale;

	return { outcome, riskLevel, userAuthorization, rationale };
}
