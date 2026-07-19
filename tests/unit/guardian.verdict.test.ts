import { describe, expect, it } from "vitest";

import {
	GUARDIAN_MAX_VERDICT_BYTES,
	GUARDIAN_OUTPUT_SCHEMA,
	GuardianVerdictError,
	parseGuardianVerdict,
} from "../../src/guardian/index.js";

describe("Guardian strict verdict contract", () => {
	it("exposes the pinned closed JSON schema", () => {
		expect(GUARDIAN_OUTPUT_SCHEMA).toEqual({
			type: "object",
			additionalProperties: false,
			properties: {
				risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
				user_authorization: {
					type: "string",
					enum: ["unknown", "low", "medium", "high"],
				},
				outcome: { type: "string", enum: ["allow", "deny"] },
				rationale: { type: "string" },
			},
			required: ["outcome"],
		});
	});

	it("accepts the abbreviated low-risk allow and applies pinned defaults", () => {
		expect(parseGuardianVerdict('  {"outcome":"allow"}\n')).toEqual({
			outcome: "allow",
			riskLevel: "low",
			userAuthorization: "unknown",
			rationale: "Auto-review returned a low-risk allow decision.",
		});
	});

	it("accepts a complete deny and trims its rationale", () => {
		expect(
			parseGuardianVerdict(
				'{"risk_level":"critical","user_authorization":"high","outcome":"deny","rationale":"  secret export  "}',
			),
		).toEqual({
			outcome: "deny",
			riskLevel: "critical",
			userAuthorization: "high",
			rationale: "secret export",
		});
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
		["wrong risk", '{"outcome":"allow","risk_level":"safe"}'],
		["wrong authorization", '{"outcome":"deny","user_authorization":null}'],
		["wrong rationale", '{"outcome":"deny","rationale":7}'],
	])("rejects %s without inferring allow", (_label, output) => {
		expect(() => parseGuardianVerdict(output)).toThrow(GuardianVerdictError);
	});

	it("rejects oversized output before parsing", () => {
		const output = JSON.stringify({ outcome: "deny", rationale: "x".repeat(GUARDIAN_MAX_VERDICT_BYTES) });
		expect(() => parseGuardianVerdict(output)).toThrow(/size limit/u);
	});
});
