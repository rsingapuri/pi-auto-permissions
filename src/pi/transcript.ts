import { Buffer } from "node:buffer";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS,
	GUARDIAN_MAX_TOOL_ENTRY_TOKENS,
	approxGuardianBytesForTokens,
	truncateGuardianText,
	type GuardianTranscriptItem,
} from "../guardian/index.js";

export const PI_GUARDIAN_MAX_TRANSCRIPT_ITEMS = 2_048;
export const PI_GUARDIAN_MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/**
 * Per-pass inspection bound. Projection has exactly two bounded passes
 * (prefix authorization discovery and reverse-recency retention), so it reads
 * at most twice this many branch indices and twice this many content indices.
 */
export const PI_GUARDIAN_MAX_PROJECTION_VISITS = 10_000;
export const PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER =
	"<guardian_truncated omitted_entries=\"unknown\" reason=\"adapter_budget\" />";
const PI_GUARDIAN_BLOCK_OMISSION_MARKER =
	"<guardian_truncated omitted_content=\"unknown\" reason=\"adapter_projection_budget\" />";
const PI_GUARDIAN_TOOL_ARGUMENT_PROJECTION_NOTE =
	"bounded common scalar projection; unlisted and nested argument values are omitted";
const PI_GUARDIAN_MAX_TOOL_ARGUMENT_SCALAR_CODE_UNITS = 256;
const PI_GUARDIAN_TOOL_ARGUMENT_KEYS = Object.freeze([
	"command",
	"path",
	"filePath",
	"file_path",
	"content",
	"oldText",
	"newText",
	"old_string",
	"new_string",
	"patch",
	"query",
	"pattern",
	"glob",
	"url",
	"cwd",
	"description",
	"timeout",
	"offset",
	"limit",
	"line",
	"start",
	"end",
	"recursive",
	"force",
] as const);

type TranscriptSession = Pick<ExtensionContext["sessionManager"], "getBranch">;

interface ProjectedItem {
	readonly item: GuardianTranscriptItem;
	readonly sourceIndex: number;
	readonly ordinal: number;
}

interface ProjectionBudget {
	remaining: number;
	omitted: boolean;
}

function consumeProjectionVisit(budget: ProjectionBudget): boolean {
	if (budget.remaining <= 0) {
		budget.omitted = true;
		return false;
	}
	budget.remaining -= 1;
	return true;
}

/** Read only own data properties. Permission preprocessing must never execute accessors. */
function ownDataProperty(value: unknown, key: PropertyKey): unknown {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return undefined;
	}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) return undefined;
		if (!("value" in descriptor)) {
			throw new TypeError("Guardian transcript evidence contains an accessor property");
		}
		return descriptor.value;
	} catch (error) {
		// A hostile Proxy or accessor is malformed session evidence. Propagate a
		// preprocessing failure so the permission review fails closed; never
		// execute the accessor or silently omit potentially relevant evidence.
		throw error instanceof Error
			? error
			: new TypeError("Guardian transcript evidence could not be read safely");
	}
}

function boundedArrayLength(value: unknown): number | undefined {
	if (!Array.isArray(value)) return undefined;
	const length = ownDataProperty(value, "length");
	return typeof length === "number" && Number.isSafeInteger(length) && length >= 0
		? length
		: undefined;
}

function arrayDataItem(value: unknown, index: number): unknown {
	return ownDataProperty(value, String(index));
}

function boundedText(text: string, tool = false): string {
	const tokenCap = tool ? GUARDIAN_MAX_TOOL_ENTRY_TOKENS : GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS;
	const maximumCodeUnits = approxGuardianBytesForTokens(tokenCap);
	let boundedInput = text;
	// Buffer.byteLength and Codex-compatible truncation are linear in their
	// input. Preclip by code units so even one adversarial block has bounded
	// projection cost; the second truncation still enforces the exact byte cap.
	if (text.length > maximumCodeUnits) {
		const marker = PI_GUARDIAN_BLOCK_OMISSION_MARKER;
		const side = Math.max(0, Math.floor((maximumCodeUnits - marker.length) / 2));
		boundedInput = `${prefixCodeUnits(text, side)}${marker}${suffixCodeUnits(text, side)}`;
	}
	return truncateGuardianText(
		boundedInput,
		tokenCap,
	).text;
}

function safeLabel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = boundedText(value).replace(/[\r\n]+/gu, " ").trim();
	return normalized.length === 0 ? fallback : normalized;
}

function safeToolName(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		/[\r\n]/u.test(value)
	) {
		return "unknown";
	}
	return value;
}

function boundedTextBlocks(content: unknown, budget: ProjectionBudget, tool = false): string {
	if (typeof content === "string") return content.length === 0 ? "" : boundedText(content, tool);
	const contentLength = boundedArrayLength(content);
	if (contentLength === undefined || contentLength === 0) return "";

	const tokenCap = tool ? GUARDIAN_MAX_TOOL_ENTRY_TOKENS : GUARDIAN_MAX_MESSAGE_ENTRY_TOKENS;
	const maximumCodeUnits = approxGuardianBytesForTokens(tokenCap);
	const visited: string[] = [];
	let codeUnits = 0;
	let index = 0;
	const prefixVisitLimit =
		contentLength > budget.remaining
			? Math.ceil(budget.remaining / 2)
			: budget.remaining;
	let prefixVisits = 0;
	for (; index < contentLength; index += 1) {
		if (prefixVisits >= prefixVisitLimit) {
			budget.omitted = true;
			break;
		}
		if (!consumeProjectionVisit(budget)) break;
		prefixVisits += 1;
		const text = textBlock(arrayDataItem(content, index));
		if (text === undefined) continue;
		const separator = visited.length === 0 ? "" : "\n";
		const remaining = maximumCodeUnits - codeUnits;
		if (separator.length + text.length <= remaining) {
			visited.push(`${separator}${text}`);
			codeUnits += separator.length + text.length;
			continue;
		}
		if (remaining > separator.length) {
			visited.push(`${separator}${prefixCodeUnits(text, remaining - separator.length)}`);
		}
		budget.omitted = true;
		break;
	}

	const joinedPrefix = visited.join("");
	if (index >= contentLength) return boundedText(joinedPrefix, tool);
	budget.omitted = true;

	const prefixBudget = Math.floor(maximumCodeUnits / 2);
	const prefix = prefixCodeUnits(joinedPrefix, prefixBudget);
	const suffixParts: string[] = [];
	let suffixCodeUnitCount = 0;
	for (let tail = contentLength - 1; tail >= index; tail -= 1) {
		if (!consumeProjectionVisit(budget)) break;
		const text = textBlock(arrayDataItem(content, tail));
		if (text === undefined) continue;
		const separator = suffixParts.length === 0 ? "" : "\n";
		const remaining = prefixBudget - suffixCodeUnitCount;
		if (remaining <= 0) break;
		const wantedText = Math.max(0, remaining - separator.length);
		const clipped = suffixCodeUnits(text, wantedText);
		suffixParts.push(`${clipped}${separator}`);
		suffixCodeUnitCount += clipped.length + separator.length;
		if (clipped.length < text.length) break;
	}
	const suffix = suffixParts.reverse().join("");
	if (prefix.length === 0 && suffix.length === 0) return "";
	return boundedText(`${prefix}\n${PI_GUARDIAN_BLOCK_OMISSION_MARKER}\n${suffix}`, tool);
}

function textBlock(block: unknown): string | undefined {
	if (ownDataProperty(block, "type") !== "text") return undefined;
	const text = ownDataProperty(block, "text");
	return typeof text === "string" ? text : undefined;
}

function boundedToolArgumentString(value: string): string {
	if (value.length <= PI_GUARDIAN_MAX_TOOL_ARGUMENT_SCALAR_CODE_UNITS) return value;
	const marker = "<guardian_argument_truncated />";
	const side = Math.max(
		0,
		Math.floor(
			(PI_GUARDIAN_MAX_TOOL_ARGUMENT_SCALAR_CODE_UNITS - marker.length) / 2,
		),
	);
	return `${prefixCodeUnits(value, side)}${marker}${suffixCodeUnits(value, side)}`;
}

function boundedToolArgumentScalar(value: unknown): string | number | boolean | null {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return boundedToolArgumentString(value);
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return `<guardian_argument_value_omitted type="${typeof value}" />`;
}

/**
 * Produce a constant-work historical argument preview. Enumerating arbitrary
 * object keys (or JSON-stringifying arbitrary values) is itself unbounded, so
 * only a fixed vocabulary of useful scalar fields is inspected. The current
 * action under review is bound separately; this preview is context only.
 */
function serializeToolArguments(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(boundedToolArgumentScalar(value));
	}

	const projection: Record<string, string | number | boolean | null> = {
		$guardian: PI_GUARDIAN_TOOL_ARGUMENT_PROJECTION_NOTE,
	};
	let retained = 0;
	try {
		for (const key of PI_GUARDIAN_TOOL_ARGUMENT_KEYS) {
			const field = ownDataProperty(value, key);
			if (field === undefined) continue;
			projection[key] = boundedToolArgumentScalar(field);
			retained += 1;
		}
	} catch {
		return "<tool_arguments_unavailable reason=\"unsafe_argument_object\" />";
	}
	if (retained === 0) {
		return "<tool_arguments_unavailable reason=\"no_common_scalar_fields\" />";
	}
	return JSON.stringify(projection);
}

function contextualLabel(text: string): GuardianTranscriptItem {
	return { kind: "user", text: boundedText(text), contextual: true };
}

function projectMessage(message: unknown, budget: ProjectionBudget): GuardianTranscriptItem[] {
	if (message === null || typeof message !== "object") return [];
	switch (ownDataProperty(message, "role")) {
		case "user": {
			const text = boundedTextBlocks(ownDataProperty(message, "content"), budget);
			return text.length === 0 ? [] : [{ kind: "user", text }];
		}
		case "assistant": {
			const content = ownDataProperty(message, "content");
			const contentLength = boundedArrayLength(content);
			if (contentLength === undefined) return [];
			const items: GuardianTranscriptItem[] = [];
			const start = Math.max(0, contentLength - budget.remaining);
			if (start > 0) budget.omitted = true;
			for (let index = start; index < contentLength; index += 1) {
				if (!consumeProjectionVisit(budget)) break;
				const block = arrayDataItem(content, index);
				if (block === null || typeof block !== "object") continue;
				const blockType = ownDataProperty(block, "type");
				if (blockType === "text") {
					const blockText = ownDataProperty(block, "text");
					if (typeof blockText === "string") {
						items.push({ kind: "assistant", text: boundedText(blockText) });
					}
				} else if (blockType === "toolCall") {
					items.push({
						kind: "tool_call",
						toolName: safeToolName(ownDataProperty(block, "name")),
						text: boundedText(
							serializeToolArguments(ownDataProperty(block, "arguments")),
							true,
						),
					});
				}
				// Thinking blocks are deliberately never copied into a permission prompt.
			}
			return items;
		}
		case "toolResult": {
			const text = boundedTextBlocks(ownDataProperty(message, "content"), budget, true);
			return text.length === 0
				? []
				: [
						{
							kind: "tool_result",
							toolName: safeToolName(ownDataProperty(message, "toolName")),
							text: boundedText(text, true),
						},
					];
		}
		case "custom":
			return [
				contextualLabel(
					`[extension context present: ${safeLabel(
						ownDataProperty(message, "customType"),
						"unknown",
					)}]`,
				),
			];
		case "bashExecution":
			return [contextualLabel("[direct user bash execution present; content omitted]")];
		case "branchSummary":
			return [contextualLabel("[branch summary present; content omitted]")];
		case "compactionSummary":
			return [contextualLabel("[compaction summary present; content omitted]")];
		default:
			return [];
	}
}

function projectEntry(
	entry: unknown,
	sourceIndex: number,
	budget: ProjectionBudget,
): ProjectedItem[] {
	let items: GuardianTranscriptItem[];
	switch (ownDataProperty(entry, "type")) {
		case "message":
			items = projectMessage(ownDataProperty(entry, "message"), budget);
			break;
		case "custom_message":
			items = [
				contextualLabel(
					`[extension context present: ${safeLabel(
						ownDataProperty(entry, "customType"),
						"unknown",
					)}]`,
				),
			];
			break;
		case "compaction":
			items = [contextualLabel("[compaction summary present; content omitted]")];
			break;
		case "branch_summary":
			items = [contextualLabel("[branch summary present; content omitted]")];
			break;
		case "label":
			{
				const label = ownDataProperty(entry, "label");
				items = label
				? [contextualLabel(`[session label: ${safeLabel(label, "present")}]`)]
				: [];
			}
			break;
		case "session_info":
			{
				const name = ownDataProperty(entry, "name");
				items = name
				? [contextualLabel(`[session name: ${safeLabel(name, "present")}]`)]
				: [];
			}
			break;
		default:
			// Custom state, model/thinking changes, and other metadata are not
			// conversational evidence and must never become authorization.
			items = [];
	}
	return items.map((item, ordinal) => ({ item, sourceIndex, ordinal }));
}

function projectFirstAuthenticUser(
	entry: unknown,
	sourceIndex: number,
	budget: ProjectionBudget,
): ProjectedItem | undefined {
	if (ownDataProperty(entry, "type") !== "message") return undefined;
	const message = ownDataProperty(entry, "message");
	if (ownDataProperty(message, "role") !== "user") return undefined;
	const text = boundedTextBlocks(ownDataProperty(message, "content"), budget);
	return text.length === 0
		? undefined
		: { item: { kind: "user", text }, sourceIndex, ordinal: 0 };
}

function itemBytes(item: GuardianTranscriptItem): number {
	return Buffer.byteLength(item.text, "utf8");
}

function sameProjection(left: ProjectedItem, right: ProjectedItem): boolean {
	return left.sourceIndex === right.sourceIndex && left.ordinal === right.ordinal;
}

/**
 * Project only the active branch into Guardian evidence. The earliest genuine
 * user text found in the bounded prefix is retained, then the most recent
 * evidence fills the fixed budget.
 * Synthetic/custom context is represented only by non-authorizing labels; its
 * payload is never copied into the authorization transcript.
 */
export function guardianTranscriptFromSession(
	sessionManager: TranscriptSession,
): readonly GuardianTranscriptItem[] {
	const branch = sessionManager.getBranch();
	const branchLength = boundedArrayLength(branch);
	if (branchLength === undefined) {
		return Object.freeze([
			Object.freeze({
				kind: "assistant" as const,
				text: PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER,
			}),
		]);
	}
	let firstUser: ProjectedItem | undefined;
	const firstBudget: ProjectionBudget = {
		remaining: PI_GUARDIAN_MAX_PROJECTION_VISITS,
		omitted: false,
	};
	for (
		let index = 0;
		index < branchLength && index < PI_GUARDIAN_MAX_PROJECTION_VISITS && firstUser === undefined;
		index += 1
	) {
		firstUser = projectFirstAuthenticUser(arrayDataItem(branch, index), index, firstBudget);
	}

	const marker: GuardianTranscriptItem = {
		kind: "assistant",
		text: PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER,
	};
	const reservedCount = (firstUser === undefined ? 0 : 1) + 1;
	const reservedBytes = (firstUser === undefined ? 0 : itemBytes(firstUser.item)) + itemBytes(marker);
	const recentReverse: ProjectedItem[] = [];
	let recentBytes = 0;
	let omitted =
		branchLength > PI_GUARDIAN_MAX_PROJECTION_VISITS || firstBudget.omitted;
	const recentBudget: ProjectionBudget = {
		remaining: PI_GUARDIAN_MAX_PROJECTION_VISITS,
		omitted: false,
	};
	let recentEntryVisits = 0;

	outer: for (let sourceIndex = branchLength - 1; sourceIndex >= 0; sourceIndex -= 1) {
		if (recentEntryVisits >= PI_GUARDIAN_MAX_PROJECTION_VISITS || recentBudget.remaining <= 0) {
			omitted = true;
			break;
		}
		recentEntryVisits += 1;
		const projected = projectEntry(arrayDataItem(branch, sourceIndex), sourceIndex, recentBudget);
		if (recentBudget.omitted) omitted = true;
		for (let ordinal = projected.length - 1; ordinal >= 0; ordinal -= 1) {
			const candidate = projected[ordinal];
			if (candidate === undefined || (firstUser !== undefined && sameProjection(candidate, firstUser))) {
				continue;
			}
			const bytes = itemBytes(candidate.item);
			if (
				recentReverse.length + reservedCount >= PI_GUARDIAN_MAX_TRANSCRIPT_ITEMS ||
				recentBytes + reservedBytes + bytes > PI_GUARDIAN_MAX_TRANSCRIPT_BYTES
			) {
				omitted = true;
				break outer;
			}
			recentReverse.push(candidate);
			recentBytes += bytes;
		}
	}
	if (recentBudget.omitted) omitted = true;

	const result: GuardianTranscriptItem[] = [];
	if (firstUser !== undefined) result.push(firstUser.item);
	if (omitted) result.push(marker);
	for (const projected of recentReverse.reverse()) result.push(projected.item);
	return Object.freeze(result.map((item) => Object.freeze(item)));
}

function prefixCodeUnits(text: string, limit: number): string {
	let end = Math.min(text.length, Math.max(0, limit));
	if (
		end > 0 &&
		end < text.length &&
		text.charCodeAt(end - 1) >= 0xd800 &&
		text.charCodeAt(end - 1) <= 0xdbff &&
		text.charCodeAt(end) >= 0xdc00 &&
		text.charCodeAt(end) <= 0xdfff
	) {
		end -= 1;
	}
	return text.slice(0, end);
}

function suffixCodeUnits(text: string, limit: number): string {
	let start = Math.max(0, text.length - Math.max(0, limit));
	if (
		start > 0 &&
		start < text.length &&
		text.charCodeAt(start) >= 0xdc00 &&
		text.charCodeAt(start) <= 0xdfff &&
		text.charCodeAt(start - 1) >= 0xd800 &&
		text.charCodeAt(start - 1) <= 0xdbff
	) {
		start += 1;
	}
	return text.slice(start);
}
