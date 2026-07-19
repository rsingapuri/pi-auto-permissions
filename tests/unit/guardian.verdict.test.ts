import { describe, expect, it } from "vitest";

import {
	GUARDIAN_MAX_VERDICT_BYTES,
	GuardianVerdictError,
	parseGuardianVerdict,
} from "../../src/guardian/index.js";

describe("Guardian strict verdict contract", () => {
	it("accepts the exact allow object", () => {
		expect(parseGuardianVerdict('  {"outcome":"allow"}\n')).toEqual({ outcome: "allow" });
	});

	it("accepts the exact deny object without inventing a risk classification", () => {
		expect(parseGuardianVerdict('{"outcome":"deny"}')).toEqual({ outcome: "deny" });
	});

	it.each([
		["empty", ""],
		["prose wrapper", 'Decision: {"outcome":"allow"}'],
		["markdown fence", '```json\n{"outcome":"allow"}\n```'],
		["two JSON values", '{"outcome":"allow"}{"outcome":"deny"}'],
		["duplicate field", '{"outcome":"deny","outcome":"allow"}'],
		["escaped duplicate field", '{"outcome":"deny","outc\\u006fme":"allow"}'],
		["array", '[{"outcome":"allow"}]'],
		["missing outcome", '{"risk_level":"low"}'],
		["ask outcome", '{"outcome":"ask"}'],
		["unknown field", '{"outcome":"allow","approved":true}'],
		["risk field", '{"outcome":"allow","risk_level":"low"}'],
		["authorization field", '{"outcome":"deny","user_authorization":"high"}'],
		["rationale field", '{"outcome":"deny","rationale":"extra"}'],
	])("rejects %s without inferring allow", (_label, output) => {
		expect(() => parseGuardianVerdict(output)).toThrow(GuardianVerdictError);
	});

	it("rejects oversized output before parsing", () => {
		const output = `${'{"outcome":"deny","extra":"'}${"x".repeat(GUARDIAN_MAX_VERDICT_BYTES)}"}`;
		expect(() => parseGuardianVerdict(output)).toThrow(/size limit/u);
	});
});
