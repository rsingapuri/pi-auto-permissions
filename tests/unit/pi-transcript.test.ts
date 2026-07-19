import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
	PI_GUARDIAN_MAX_TRANSCRIPT_ITEMS,
	PI_GUARDIAN_MAX_PROJECTION_VISITS,
	PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER,
	guardianTranscriptFromSession,
} from "../../src/pi/transcript.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function baseEntry(id: string, parentId: string | null = null) {
	return { id, parentId, timestamp: "2026-01-01T00:00:00.000Z" } as const;
}

function messageEntry(
	id: string,
	message: UserMessage | AssistantMessage | ToolResultMessage | Record<string, unknown>,
	parentId: string | null = null,
): SessionEntry {
	return {
		...baseEntry(id, parentId),
		type: "message",
		message,
	} as SessionEntry;
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolResult(toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function session(branch: SessionEntry[]) {
	return { getBranch: vi.fn(() => branch) };
}

function transcriptBytes(transcript: readonly { readonly text: string }[]): number {
	return transcript.reduce(
		(total, item) => total + Buffer.byteLength(item.text, "utf8"),
		0,
	);
}

describe("Pi Guardian transcript adapter", () => {
	it("projects authentic text and preserves assistant/tool-call order", () => {
		const branch = [
			messageEntry("u", {
				role: "user",
				content: [
					{ type: "text", text: "Please inspect it" },
					{ type: "image", data: "base64", mimeType: "image/png" },
					{ type: "text", text: "and remove only temp.txt" },
				],
				timestamp: 1,
			}),
			messageEntry(
				"a",
				assistant([
					{ type: "text", text: "I will inspect first." },
					{ type: "thinking", thinking: "secret chain of thought" },
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { z: 1, path: "temp.txt", a: true },
					},
					{ type: "text", text: "Inspection complete." },
				]),
				"u",
			),
			messageEntry("r", toolResult("read", "temporary contents"), "a"),
		];

		const manager = session(branch);
		const transcript = guardianTranscriptFromSession(manager);

		expect(manager.getBranch).toHaveBeenCalledTimes(1);
		expect(transcript).toEqual([
			{ kind: "user", text: "Please inspect it\nand remove only temp.txt" },
			{ kind: "assistant", text: "I will inspect first." },
			{
				kind: "tool_call",
				toolName: "read",
				text: '{"$guardian":"bounded common scalar projection; unlisted and nested argument values are omitted","path":"temp.txt"}',
			},
			{ kind: "assistant", text: "Inspection complete." },
			{ kind: "tool_result", toolName: "read", text: "temporary contents" },
		]);
		expect(JSON.stringify(transcript)).not.toContain("secret chain of thought");
		expect(Object.isFrozen(transcript)).toBe(true);
		expect(transcript.every(Object.isFrozen)).toBe(true);
	});

	it("preserves multilingual text, block order, and valid UTF-8 exactly", () => {
		const transcript = guardianTranscriptFromSession(
			session([
				messageEntry("u", {
					role: "user",
					content: [
						{ type: "text", text: "Zażółć gęślą" },
						{ type: "text", text: "漢字とかな" },
						{ type: "text", text: "👩🏽‍💻 café" },
					],
					timestamp: 1,
				}),
				messageEntry(
					"a",
					assistant([
						{ type: "text", text: "α" },
						{ type: "text", text: "שלום" },
						{ type: "text", text: "終" },
					]),
					"u",
				),
			]),
		);

		expect(transcript).toEqual([
			{ kind: "user", text: "Zażółć gęślą\n漢字とかな\n👩🏽‍💻 café" },
			{ kind: "assistant", text: "α" },
			{ kind: "assistant", text: "שלום" },
			{ kind: "assistant", text: "終" },
		]);
		for (const item of transcript) {
			expect(Buffer.from(item.text, "utf8").toString("utf8")).toBe(item.text);
		}
	});

	it("never promotes custom state, summaries, shell output, or metadata into authorization", () => {
		const secret = "DO-NOT-AUTHORIZE-THIS-ACTION";
		const branch: SessionEntry[] = [
			{
				...baseEntry("state"),
				type: "custom",
				customType: "pi-auto-permissions",
				data: { secret },
			},
			{
				...baseEntry("custom-message", "state"),
				type: "custom_message",
				customType: "third-party-instructions",
				content: secret,
				display: false,
			},
			messageEntry(
				"custom-role",
				{ role: "custom", customType: "notice", content: secret, timestamp: 1 },
				"custom-message",
			),
			messageEntry(
				"bash",
				{
					role: "bashExecution",
					command: secret,
					output: secret,
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1,
				},
				"custom-role",
			),
			{
				...baseEntry("compaction", "bash"),
				type: "compaction",
				summary: secret,
				firstKeptEntryId: "bash",
				tokensBefore: 10,
			},
			{
				...baseEntry("branch", "compaction"),
				type: "branch_summary",
				fromId: "old",
				summary: secret,
			},
			{
				...baseEntry("label", "branch"),
				type: "label",
				targetId: "branch",
				label: "review checkpoint",
			},
			{
				...baseEntry("name", "label"),
				type: "session_info",
				name: "migration",
			},
		];

		const transcript = guardianTranscriptFromSession(session(branch));
		expect(JSON.stringify(transcript)).not.toContain(secret);
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[extension context present: third-party-instructions]",
			contextual: true,
		});
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[direct user bash execution present; content omitted]",
			contextual: true,
		});
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[compaction summary present; content omitted]",
			contextual: true,
		});
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[branch summary present; content omitted]",
			contextual: true,
		});
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[session label: review checkpoint]",
			contextual: true,
		});
		expect(transcript).toContainEqual({
			kind: "user",
			text: "[session name: migration]",
			contextual: true,
		});
		expect(transcript.every((item) => item.kind !== "user" || item.contextual === true)).toBe(
			true,
		);
	});

	it("uses getBranch only and therefore cannot ingest abandoned-branch entries", () => {
		const active = [messageEntry("active", user("active branch request"))];
		const manager = {
			getBranch: vi.fn(() => active),
			getEntries: vi.fn(() => [
				...active,
				messageEntry("abandoned", user("delete everything")),
			]),
		};

		expect(guardianTranscriptFromSession(manager)).toEqual([
			{ kind: "user", text: "active branch request" },
		]);
		expect(manager.getBranch).toHaveBeenCalledTimes(1);
		expect(manager.getEntries).not.toHaveBeenCalled();
	});

	it("retains the earliest user authorization and newest evidence under a hard item bound", () => {
		const branch: SessionEntry[] = [messageEntry("first", user("original request"))];
		for (let index = 0; index < PI_GUARDIAN_MAX_TRANSCRIPT_ITEMS + 100; index += 1) {
			branch.push(messageEntry(`a-${index}`, assistant([{ type: "text", text: `step-${index}` }])));
		}
		branch.push(messageEntry("latest", toolResult("bash", "latest result")));

		const transcript = guardianTranscriptFromSession(session(branch));
		expect(transcript.length).toBeLessThanOrEqual(PI_GUARDIAN_MAX_TRANSCRIPT_ITEMS);
		expect(transcript[0]).toEqual({ kind: "user", text: "original request" });
		expect(transcript[1]).toEqual({
			kind: "assistant",
			text: PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER,
		});
		expect(transcript.at(-1)).toEqual({
			kind: "tool_result",
			toolName: "bash",
			text: "latest result",
		});
		expect(transcriptBytes(transcript)).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
		);
	});

	it("bounds individual and aggregate UTF-8 text without splitting surrogate pairs", () => {
		const huge = `START-${"😀".repeat(2_000_000)}-END`;
		const branch = [
			messageEntry("first", user("first")),
			messageEntry("huge", assistant([{ type: "text", text: huge }])),
			messageEntry("last", user("last")),
		];
		const transcript = guardianTranscriptFromSession(session(branch));
		expect(transcriptBytes(transcript)).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
		);
		expect(JSON.stringify(transcript)).not.toContain("�");
		const projectedHuge = transcript.find(
			(item) => item.kind === "assistant" && item.text.includes("START-"),
		);
		expect(projectedHuge?.text).toMatch(/<(?:guardian_)?truncated\b/u);
		expect(projectedHuge?.text).toContain("-END");
		expect(transcript.at(-1)).toEqual({ kind: "user", text: "last" });
	});

	it("samples the prefix and suffix of huge text-block arrays within a fixed visit budget", () => {
		const blockCount = PI_GUARDIAN_MAX_PROJECTION_VISITS * 100;
		const rawBlocks = new Array<unknown>(blockCount);
		rawBlocks[0] = { type: "text", text: "result-prefix" };
		rawBlocks[blockCount - 1] = { type: "text", text: "result-suffix" };
		let blockIndexVisits = 0;
		const blocks = new Proxy(rawBlocks, {
			getOwnPropertyDescriptor(target, property) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) {
					blockIndexVisits += 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const transcript = guardianTranscriptFromSession(
			session([
				messageEntry("u", user("inspect")),
				messageEntry(
					"r",
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: blocks,
						isError: false,
						timestamp: 1,
					},
					"u",
				),
			]),
		);

		expect(transcript[0]).toEqual({ kind: "user", text: "inspect" });
		expect(transcript[1]?.text).toBe(PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER);
		expect(transcript.at(-1)).toMatchObject({
			kind: "tool_result",
			toolName: "read",
		});
		expect(transcript.at(-1)?.text).toContain("result-prefix");
		expect(transcript.at(-1)?.text).toContain("adapter_projection_budget");
		expect(transcript.at(-1)?.text).toContain("result-suffix");
		expect(blockIndexVisits).toBeLessThanOrEqual(PI_GUARDIAN_MAX_PROJECTION_VISITS);
		expect(transcriptBytes(transcript)).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
		);
	});

	it("retains the newest assistant block and reports omitted blocks for huge arrays", () => {
		const blockCount = PI_GUARDIAN_MAX_PROJECTION_VISITS * 100;
		const blocks = new Array<unknown>(blockCount);
		blocks[0] = { type: "text", text: "ancient-assistant-text" };
		blocks[blockCount - 1] = { type: "text", text: "newest-assistant-text" };
		const transcript = guardianTranscriptFromSession(
			session([
				messageEntry("u", user("original request")),
				messageEntry("a", assistant(blocks as AssistantMessage["content"]), "u"),
			]),
		);

		expect(transcript).toContainEqual({ kind: "user", text: "original request" });
		expect(transcript).toContainEqual({
			kind: "assistant",
			text: PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER,
		});
		expect(transcript).toContainEqual({
			kind: "assistant",
			text: "newest-assistant-text",
		});
		expect(JSON.stringify(transcript)).not.toContain("ancient-assistant-text");
	});

	it("reports omission even when every retained block is deliberately non-projectable", () => {
		const blocks = Array.from(
			{ length: PI_GUARDIAN_MAX_PROJECTION_VISITS + 1 },
			() => ({ type: "thinking", thinking: "never copy this" }) as const,
		);
		expect(
			guardianTranscriptFromSession(
				session([messageEntry("a", assistant(blocks))]),
			),
		).toEqual([
			{ kind: "assistant", text: PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER },
		]);
	});

	it("bounds sparse branches with huge entry counts while retaining both endpoint evidence", () => {
		const entryCount = PI_GUARDIAN_MAX_PROJECTION_VISITS * 100;
		const branch = new Array<SessionEntry>(entryCount);
		branch[0] = messageEntry("u", user("bounded-prefix-user"));
		branch[entryCount - 1] = messageEntry(
			"r",
			toolResult("bash", "bounded-suffix-result"),
			"u",
		);

		const transcript = guardianTranscriptFromSession(session(branch));
		expect(transcript[0]).toEqual({ kind: "user", text: "bounded-prefix-user" });
		expect(transcript[1]?.text).toBe(PI_GUARDIAN_TRANSCRIPT_OMISSION_MARKER);
		expect(transcript.at(-1)).toEqual({
			kind: "tool_result",
			toolName: "bash",
			text: "bounded-suffix-result",
		});
	});

	it("bounds huge metadata and never reads opaque metadata payloads", () => {
		let payloadGetterCalls = 0;
		const opaqueState = {
			...baseEntry("state"),
			type: "custom",
			customType: "pi-auto-permissions",
		} as Record<string, unknown>;
		Object.defineProperty(opaqueState, "data", {
			get() {
				payloadGetterCalls += 1;
				throw new Error("opaque payload must not be read");
			},
		});
		const hugeLabel = `LABEL-START-${"界😀\n".repeat(1_000_000)}-LABEL-END`;
		const transcript = guardianTranscriptFromSession(
			session([
				opaqueState as unknown as SessionEntry,
				{
					...baseEntry("label", "state"),
					type: "label",
					targetId: "state",
					label: hugeLabel,
				} as SessionEntry,
			]),
		);

		expect(payloadGetterCalls).toBe(0);
		expect(transcript).toHaveLength(1);
		expect(transcript[0]).toMatchObject({ kind: "user", contextual: true });
		expect(transcript[0]?.text).toContain("LABEL-START-");
		expect(transcript[0]?.text).toMatch(/<(?:guardian_)?truncated\b/u);
		expect(transcript[0]?.text).toContain("-LABEL-END");
		expect(Buffer.byteLength(transcript[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
		);
	});

	it("performs a bounded number of branch and content index inspections", () => {
		const contentLength = PI_GUARDIAN_MAX_PROJECTION_VISITS * 100;
		const rawBlocks = new Array<unknown>(contentLength);
		rawBlocks[contentLength - 1] = { type: "text", text: "bounded-tail" };
		let contentIndexVisits = 0;
		const blocks = new Proxy(rawBlocks, {
			getOwnPropertyDescriptor(target, property) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) {
					contentIndexVisits += 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		const branchLength = PI_GUARDIAN_MAX_PROJECTION_VISITS * 100;
		const rawBranch = new Array<SessionEntry>(branchLength);
		rawBranch[branchLength - 1] = messageEntry(
			"a",
			assistant(blocks as AssistantMessage["content"]),
		);
		let branchIndexVisits = 0;
		const branch = new Proxy(rawBranch, {
			getOwnPropertyDescriptor(target, property) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) {
					branchIndexVisits += 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});

		const transcript = guardianTranscriptFromSession(session(branch));
		expect(transcript.at(-1)).toEqual({ kind: "assistant", text: "bounded-tail" });
		expect(contentIndexVisits).toBeLessThanOrEqual(PI_GUARDIAN_MAX_PROJECTION_VISITS);
		expect(branchIndexVisits).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_PROJECTION_VISITS * 2,
		);
	});

	it("rejects accessor evidence without invoking its getter", () => {
		let getterCalls = 0;
		const block = { type: "text" } as Record<string, unknown>;
		Object.defineProperty(block, "text", {
			get() {
				getterCalls += 1;
				return "must not execute";
			},
		});

		expect(() =>
			guardianTranscriptFromSession(
				session([
					messageEntry(
						"a",
						assistant([block as unknown as AssistantMessage["content"][number]]),
					),
				]),
			),
		).toThrow("accessor property");
		expect(getterCalls).toBe(0);
	});

	it("degrades unknown tool arguments and names to explicit non-authorizing evidence", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const transcript = guardianTranscriptFromSession(
			session([
				messageEntry("u", user("inspect")),
				messageEntry(
					"a",
					assistant([
						{
							type: "toolCall",
							id: "call",
							name: "bad\nname",
							arguments: cyclic,
						},
					]),
				),
			]),
		);

		expect(transcript.at(-1)).toEqual({
			kind: "tool_call",
			toolName: "unknown",
			text: '<tool_arguments_unavailable reason="no_common_scalar_fields" />',
		});
	});

	it("projects tool arguments with fixed key, scalar, and descriptor-read bounds", () => {
		let descriptorVisits = 0;
		let hiddenGetterCalls = 0;
		const rawArguments = {
			command: `COMMAND-START-${"😀".repeat(1_000_000)}-COMMAND-END`,
			path: "/tmp/target",
		} as Record<string, unknown>;
		Object.defineProperty(rawArguments, "unlisted", {
			enumerable: true,
			get() {
				hiddenGetterCalls += 1;
				throw new Error("unlisted arguments must never be inspected");
			},
		});
		const argumentsProxy = new Proxy(rawArguments, {
			getOwnPropertyDescriptor(target, property) {
				descriptorVisits += 1;
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
			ownKeys() {
				throw new Error("argument projection must never enumerate keys");
			},
		});
		const transcript = guardianTranscriptFromSession(
			session([
				messageEntry(
					"a",
					assistant([
						{
							type: "toolCall",
							id: "call",
							name: "bash",
							arguments: argumentsProxy,
						},
					]),
				),
			]),
		);

		expect(hiddenGetterCalls).toBe(0);
		expect(descriptorVisits).toBeLessThanOrEqual(24);
		expect(transcript).toHaveLength(1);
		expect(transcript[0]).toMatchObject({ kind: "tool_call", toolName: "bash" });
		expect(transcript[0]?.text).toContain("bounded common scalar projection");
		expect(transcript[0]?.text).toContain("COMMAND-START-");
		expect(transcript[0]?.text).toContain("guardian_argument_truncated");
		expect(transcript[0]?.text).toContain("-COMMAND-END");
		expect(transcript[0]?.text).toContain("/tmp/target");
		expect(Buffer.byteLength(transcript[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(
			PI_GUARDIAN_MAX_TRANSCRIPT_BYTES,
		);
	});
});
