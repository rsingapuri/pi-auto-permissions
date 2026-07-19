/*
 * Adapted and modified from OpenAI Codex
 * codex-rs/core/src/guardian/mod.rs at commit
 * 0fb559f0f6e231a88ac02ea002d3ecd248e2b515; Apache-2.0.
 */
export const GUARDIAN_CONSECUTIVE_DENIAL_LIMIT = 3;
export const GUARDIAN_RECENT_DENIAL_LIMIT = 10;
export const GUARDIAN_DENIAL_WINDOW_SIZE = 50;
export const GUARDIAN_MAX_TRACKED_TURNS = 256;

interface MutableTurnHistory {
	consecutiveDenials: number;
	recentDenials: boolean[];
	interruptTriggered: boolean;
}

export interface GuardianCircuitBreakerSnapshot {
	readonly consecutiveDenials: number;
	readonly recentDenials: number;
	readonly interruptTurn: boolean;
}

/**
 * A bounded, per-turn denial history. Interruption is sticky until the caller
 * ends/clears the turn, so a model cannot resume its denied-action loop.
 */
export class GuardianDenialCircuitBreaker {
	readonly #turns = new Map<string, MutableTurnHistory>();

	clearTurn(turnId: string): void {
		this.#turns.delete(turnId);
	}

	isInterrupted(turnId: string): boolean {
		return this.#turns.get(turnId)?.interruptTriggered ?? false;
	}

	recordDenial(turnId: string): GuardianCircuitBreakerSnapshot {
		const turn = this.#getOrCreateTurn(turnId);
		turn.consecutiveDenials += 1;
		this.#recordRecent(turn, true);
		const recentDenials = turn.recentDenials.filter(Boolean).length;
		if (
			turn.consecutiveDenials >= GUARDIAN_CONSECUTIVE_DENIAL_LIMIT ||
			recentDenials >= GUARDIAN_RECENT_DENIAL_LIMIT
		) {
			turn.interruptTriggered = true;
		}
		return {
			consecutiveDenials: turn.consecutiveDenials,
			recentDenials,
			interruptTurn: turn.interruptTriggered,
		};
	}

	recordNonDenial(turnId: string): GuardianCircuitBreakerSnapshot {
		const turn = this.#getOrCreateTurn(turnId);
		turn.consecutiveDenials = 0;
		this.#recordRecent(turn, false);
		return {
			consecutiveDenials: 0,
			recentDenials: turn.recentDenials.filter(Boolean).length,
			interruptTurn: turn.interruptTriggered,
		};
	}

	snapshot(turnId: string): GuardianCircuitBreakerSnapshot {
		const turn = this.#turns.get(turnId);
		if (turn === undefined) {
			return { consecutiveDenials: 0, recentDenials: 0, interruptTurn: false };
		}
		return {
			consecutiveDenials: turn.consecutiveDenials,
			recentDenials: turn.recentDenials.filter(Boolean).length,
			interruptTurn: turn.interruptTriggered,
		};
	}

	#getOrCreateTurn(turnId: string): MutableTurnHistory {
		const existing = this.#turns.get(turnId);
		if (existing !== undefined) return existing;

		if (this.#turns.size >= GUARDIAN_MAX_TRACKED_TURNS) {
			const oldest = this.#turns.keys().next().value as string | undefined;
			if (oldest !== undefined) this.#turns.delete(oldest);
		}
		const created: MutableTurnHistory = {
			consecutiveDenials: 0,
			recentDenials: [],
			interruptTriggered: false,
		};
		this.#turns.set(turnId, created);
		return created;
	}

	#recordRecent(turn: MutableTurnHistory, denied: boolean): void {
		turn.recentDenials.push(denied);
		if (turn.recentDenials.length > GUARDIAN_DENIAL_WINDOW_SIZE) {
			turn.recentDenials.shift();
		}
	}
}
