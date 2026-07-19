import { describe, expect, it } from "vitest";

import {
	GUARDIAN_DENIAL_WINDOW_SIZE,
	GuardianDenialCircuitBreaker,
} from "../../src/guardian/index.js";

describe("Guardian denial circuit breaker", () => {
	it("I16 interrupts on the third consecutive denial and remains sticky", () => {
		const breaker = new GuardianDenialCircuitBreaker();

		expect(breaker.recordDenial("turn").interruptTurn).toBe(false);
		expect(breaker.recordDenial("turn").interruptTurn).toBe(false);
		expect(breaker.recordDenial("turn")).toMatchObject({
			consecutiveDenials: 3,
			interruptTurn: true,
		});
		breaker.recordNonDenial("turn");
		expect(breaker.isInterrupted("turn")).toBe(true);
	});

	it("a non-denial resets the consecutive count", () => {
		const breaker = new GuardianDenialCircuitBreaker();
		breaker.recordDenial("turn");
		breaker.recordDenial("turn");
		breaker.recordNonDenial("turn");

		expect(breaker.recordDenial("turn")).toMatchObject({
			consecutiveDenials: 1,
			interruptTurn: false,
		});
	});

	it("I16 interrupts on ten non-consecutive denials in the latest fifty reviews", () => {
		const breaker = new GuardianDenialCircuitBreaker();
		for (let index = 0; index < 9; index += 1) {
			breaker.recordDenial("turn");
			breaker.recordNonDenial("turn");
		}

		expect(breaker.recordDenial("turn")).toMatchObject({
			recentDenials: 10,
			interruptTurn: true,
		});
	});

	it("expires old denials outside the rolling window", () => {
		const breaker = new GuardianDenialCircuitBreaker();
		for (let index = 0; index < 9; index += 1) {
			breaker.recordDenial("turn");
			breaker.recordNonDenial("turn");
		}
		for (let index = 0; index < GUARDIAN_DENIAL_WINDOW_SIZE; index += 1) {
			breaker.recordNonDenial("turn");
		}

		expect(breaker.snapshot("turn")).toEqual({
			consecutiveDenials: 0,
			recentDenials: 0,
			interruptTurn: false,
		});
	});

	it("clears completed turns", () => {
		const breaker = new GuardianDenialCircuitBreaker();
		breaker.recordDenial("turn");
		breaker.clearTurn("turn");
		expect(breaker.snapshot("turn")).toEqual({
			consecutiveDenials: 0,
			recentDenials: 0,
			interruptTurn: false,
		});
	});
});
