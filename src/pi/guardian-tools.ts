import { constants } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { basename, isAbsolute, matchesGlob, relative, resolve } from "node:path";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_WALK_ENTRIES = 20_000;
const MAX_FIND_RESULTS = 1_000;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILES = 200;
const MAX_GREP_BYTES = 4 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

const readSchema = Type.Object({
	path: Type.String({ description: "Path to a regular text file (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Literal text to search for" }),
	path: Type.Optional(Type.String({ description: "File or directory to search" })),
	glob: Type.Optional(Type.String({ description: "Glob filter" })),
	ignoreCase: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number({ description: "Context lines around matches" })),
	limit: Type.Optional(Type.Number({ description: "Maximum matches to return" })),
});

const findSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match files" }),
	path: Type.Optional(Type.String({ description: "Directory to search" })),
	limit: Type.Optional(Type.Number({ description: "Maximum results to return" })),
});

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list" })),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return" })),
});

function textResult(text: string): AgentToolResult<Record<string, never>> {
	return { content: [{ type: "text", text }], details: {} };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("Guardian investigation was aborted");
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Limit must be a positive integer");
	return Math.min(value, maximum);
}

function investigationPath(cwd: string, input: string | undefined): string {
	const raw = input ?? ".";
	return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

function boundedText(text: string, maximumBytes = MAX_OUTPUT_BYTES): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maximumBytes) return text;
	return `${bytes.subarray(0, maximumBytes).toString("utf8")}\n<truncated />`;
}

async function readRegularFile(path: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) throw new Error("Guardian read accepts only regular files");
		const bytesToRead = Math.min(metadata.size, MAX_READ_BYTES);
		const buffer = Buffer.alloc(bytesToRead);
		const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
		throwIfAborted(signal);
		const suffix = metadata.size > bytesRead ? "\n<truncated />" : "";
		return `${buffer.subarray(0, bytesRead).toString("utf8")}${suffix}`;
	} finally {
		await handle.close();
	}
}

interface WalkState {
	truncated: boolean;
}

async function* walkFiles(
	root: string,
	signal: AbortSignal | undefined,
	state: WalkState,
): AsyncGenerator<string> {
	const rootMetadata = await stat(root);
	if (rootMetadata.isFile()) {
		yield root;
		return;
	}
	if (!rootMetadata.isDirectory()) throw new Error("Guardian search path is not a file or directory");

	const queue = [root];
	let visited = 0;
	while (queue.length > 0 && visited < MAX_WALK_ENTRIES) {
		throwIfAborted(signal);
		const directoryPath = queue.shift();
		if (directoryPath === undefined) break;
		const directory = await opendir(directoryPath);
		try {
			for (;;) {
				throwIfAborted(signal);
				const entry = await directory.read();
				if (entry === null) break;
				visited += 1;
				if (visited > MAX_WALK_ENTRIES) {
					state.truncated = true;
					return;
				}
				const path = resolve(directoryPath, entry.name);
				if (entry.isDirectory()) {
					if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path);
				} else if (entry.isFile()) {
					yield path;
				}
			}
		} finally {
			await directory.close().catch(() => undefined);
		}
	}
	if (queue.length > 0) state.truncated = true;
}

function globMatches(path: string, pattern: string): boolean {
	return matchesGlob(path, pattern) || (!pattern.includes("/") && matchesGlob(basename(path), pattern));
}

async function grepLocalText(
	cwd: string,
	args: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		context?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const root = investigationPath(cwd, args.path);
	const limit = positiveInteger(args.limit, MAX_GREP_MATCHES, MAX_GREP_MATCHES);
	const context = args.context ?? 0;
	if (!Number.isSafeInteger(context) || context < 0 || context > 100) {
		throw new Error("Grep context must be an integer from 0 through 100");
	}
	const needle = args.ignoreCase === true ? args.pattern.toLocaleLowerCase() : args.pattern;
	const results: string[] = [];
	let filesRead = 0;
	let bytesRead = 0;
	let matches = 0;
	let truncated = false;
	const walkState: WalkState = { truncated: false };

	for await (const path of walkFiles(root, signal, walkState)) {
		throwIfAborted(signal);
		const fromRoot = relative(root, path) || basename(path);
		if (args.glob !== undefined && !globMatches(fromRoot, args.glob)) continue;
		if (filesRead >= MAX_GREP_FILES || bytesRead >= MAX_GREP_BYTES) {
			truncated = true;
			break;
		}
		const text = await readRegularFile(path, signal);
		filesRead += 1;
		bytesRead += Buffer.byteLength(text, "utf8");
		if (text.includes("\0")) continue;
		const lines = text.split(/\r?\n/u);
		for (let index = 0; index < lines.length; index += 1) {
			throwIfAborted(signal);
			const line = lines[index] ?? "";
			const haystack = args.ignoreCase === true ? line.toLocaleLowerCase() : line;
			if (!haystack.includes(needle)) continue;
			matches += 1;
			const start = Math.max(0, index - context);
			const end = Math.min(lines.length - 1, index + context);
			for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
				results.push(`${relative(cwd, path) || basename(path)}:${contextIndex + 1}:${lines[contextIndex] ?? ""}`);
			}
			if (matches >= limit) {
				truncated = index + 1 < lines.length || filesRead < MAX_GREP_FILES;
				break;
			}
		}
		if (truncated) break;
	}

	truncated ||= walkState.truncated;
	const output = results.length > 0 ? results.join("\n") : "No matches found";
	return boundedText(`${output}${truncated ? "\n<truncated />" : ""}`);
}

export function createGuardianInvestigationTools(cwd: string): AgentTool[] {
	const readTool: AgentTool<typeof readSchema, Record<string, never>> = {
		name: "read",
		label: "Read",
		description: "Read a bounded regular text file for evidence. This tool cannot mutate files.",
		parameters: readSchema,
		async execute(_id, args, signal) {
			const offset = positiveInteger(args.offset, 1, Number.MAX_SAFE_INTEGER);
			const limit = positiveInteger(args.limit, MAX_READ_LINES, MAX_READ_LINES);
			const text = await readRegularFile(investigationPath(cwd, args.path), signal);
			const lines = text.split(/\r?\n/u).slice(offset - 1, offset - 1 + limit);
			return textResult(boundedText(lines.join("\n")));
		},
	};

	const grepTool: AgentTool<typeof grepSchema, Record<string, never>> = {
		name: "grep",
		label: "Grep",
		description: "Search bounded local text for a literal string without executing a helper.",
		parameters: grepSchema,
		async execute(_id, args, signal) {
			return textResult(await grepLocalText(cwd, args, signal));
		},
	};

	const findTool: AgentTool<typeof findSchema, Record<string, never>> = {
		name: "find",
		label: "Find",
		description: "Find local files by glob without modifying the filesystem.",
		parameters: findSchema,
		async execute(_id, args, signal) {
			const root = investigationPath(cwd, args.path);
			const limit = positiveInteger(args.limit, MAX_FIND_RESULTS, MAX_FIND_RESULTS);
			const results: string[] = [];
			const walkState: WalkState = { truncated: false };
			for await (const path of walkFiles(root, signal, walkState)) {
				const fromRoot = relative(root, path) || basename(path);
				if (globMatches(fromRoot, args.pattern)) results.push(relative(cwd, path) || basename(path));
				if (results.length >= limit) {
					walkState.truncated = true;
					break;
				}
			}
			const output = results.length > 0 ? results.join("\n") : "No files found";
			return textResult(`${output}${walkState.truncated ? "\n<truncated />" : ""}`);
		},
	};

	const lsTool: AgentTool<typeof lsSchema, Record<string, never>> = {
		name: "ls",
		label: "List",
		description: "List a bounded local directory without modifying it.",
		parameters: lsSchema,
		async execute(_id, args, signal) {
			throwIfAborted(signal);
			const path = investigationPath(cwd, args.path);
			const metadata = await stat(path);
			if (!metadata.isDirectory()) throw new Error("Guardian ls path is not a directory");
			const limit = positiveInteger(args.limit, MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES);
			const rendered: string[] = [];
			const directory = await opendir(path);
			try {
				while (rendered.length <= limit) {
					throwIfAborted(signal);
					const entry = await directory.read();
					if (entry === null) break;
					rendered.push(`${entry.name}${entry.isDirectory() ? "/" : ""}`);
				}
			} finally {
				await directory.close().catch(() => undefined);
			}
			const truncated = rendered.length > limit;
			if (truncated) rendered.length = limit;
			rendered.sort((left, right) => left.localeCompare(right));
			if (truncated) rendered.push("<truncated />");
			return textResult(rendered.length > 0 ? rendered.join("\n") : "<empty directory>");
		},
	};

	return [readTool, grepTool, findTool, lsTool];
}
