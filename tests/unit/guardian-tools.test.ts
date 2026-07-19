import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createGuardianInvestigationTools } from "../../src/pi/guardian-tools.js";

function tool(tools: AgentTool[], name: string): AgentTool {
	const selected = tools.find((candidate) => candidate.name === name);
	if (selected === undefined) throw new Error(`Missing tool ${name}`);
	return selected;
}

function resultText(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
	const block = result.content[0];
	return block?.type === "text" ? block.text : "";
}

describe("Guardian investigation tools", () => {
	it("reads, lists, and finds local evidence without mutation", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guardian-investigation-"));
		try {
			await mkdir(join(cwd, "nested"));
			await writeFile(join(cwd, "evidence.txt"), "first\nsecond\n", "utf8");
			await writeFile(join(cwd, "nested", "other.txt"), "other\n", "utf8");
			const tools = createGuardianInvestigationTools(cwd);
			const signal = new AbortController().signal;

			expect(
				resultText(await tool(tools, "read").execute("r", { path: "evidence.txt" }, signal)),
			).toBe("first\nsecond\n");
			expect(resultText(await tool(tools, "ls").execute("l", {}, signal))).toContain(
				"nested/",
			);
			const found = resultText(
				await tool(tools, "find").execute("f", { pattern: "*.txt" }, signal),
			);
			expect(found).toContain("evidence.txt");
			expect(found).toContain(join("nested", "other.txt"));
			expect((await readdir(cwd)).sort()).toEqual(["evidence.txt", "nested"]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("bounds directory iteration output", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guardian-large-directory-"));
		try {
			await Promise.all(
				Array.from({ length: 510 }, (_, index) =>
					writeFile(join(cwd, `entry-${String(index).padStart(3, "0")}`), "", "utf8"),
				),
			);
			const result = await tool(createGuardianInvestigationTools(cwd), "ls").execute(
				"l",
				{},
				new AbortController().signal,
			);
			const lines = resultText(result).split("\n");
			expect(lines).toHaveLength(501);
			expect(lines.at(-1)).toBe("<truncated />");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("searches in-process without executing a project-controlled rg", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guardian-no-helper-"));
		const originalPath = process.env.PATH;
		try {
			const bin = join(cwd, "node_modules", ".bin");
			const sentinel = join(cwd, "sentinel");
			await mkdir(bin, { recursive: true });
			await writeFile(join(bin, "rg"), `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`, {
				mode: 0o755,
			});
			await writeFile(join(cwd, "evidence.txt"), "needle\n", "utf8");
			process.env.PATH = `${bin}:${originalPath ?? ""}`;
			const grep = tool(createGuardianInvestigationTools(cwd), "grep");
			const result = await grep.execute(
				"g",
				{ pattern: "needle", path: ".", glob: "*.txt" },
				new AbortController().signal,
			);
			expect(resultText(result)).toContain("evidence.txt:1:needle");
			await expect(stat(sentinel)).rejects.toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects already-cancelled investigations before filesystem or process work", async () => {
		const controller = new AbortController();
		controller.abort();
		const tools = createGuardianInvestigationTools(process.cwd());
		await expect(tool(tools, "ls").execute("l", {}, controller.signal)).rejects.toThrow(
			"aborted",
		);
		await expect(
			tool(tools, "grep").execute("g", { pattern: "x" }, controller.signal),
		).rejects.toThrow("aborted");
	});
});
