import { encodeWords } from './abi.ts';
import { bytesToBigint } from './hex.ts';
import type { Keccak256 } from './keccak.ts';

// PUBLIC-SPEC §5. Exhausting it reverts, and the round becomes refundable.
export const MAX_ATTEMPTS = 256n;

// Inclusive on both ends, like entry ranges (PUBLIC-SPEC §6).
export interface Range {
  startIndex: bigint;
  endIndex: bigint;
}

export type Derivation =
  | { outcome: 'index'; index: bigint; attempts: bigint }
  | { outcome: 'revert'; error: 'NoEligibleIndex'; attempts: bigint };

// Recomputes the winning index from public inputs alone (PUBLIC-SPEC §5):
//   idx = uint256(keccak256(abi.encode(seed, roundId, drawNonce, i))) % totalTickets
// for i = 0, 1, … until idx is outside every excluded range.
//
// roundId in the preimage stops one VRF output from being reused across
// rounds; drawNonce makes each redraw independent of the draw before it; i
// lets a redraw step past forfeited ranges. `attempts` is the i that
// succeeded, reported so that a preimage missing i shows up even on cases
// where the index happens to match.
export function deriveIndex(
  keccak: Keccak256,
  seed: bigint,
  roundId: bigint,
  drawNonce: bigint,
  totalTickets: bigint,
  excluded: readonly Range[],
): Derivation {
  if (totalTickets <= 0n) throw new Error('cannot derive an index for a round with no tickets');
  for (let i = 0n; i < MAX_ATTEMPTS; i++) {
    const idx = bytesToBigint(keccak(encodeWords([seed, roundId, drawNonce, i]))) % totalTickets;
    if (!isExcluded(idx, excluded)) return { outcome: 'index', index: idx, attempts: i };
  }
  return { outcome: 'revert', error: 'NoEligibleIndex', attempts: MAX_ATTEMPTS };
}

export function isExcluded(idx: bigint, excluded: readonly Range[]): boolean {
  return excluded.some((r) => r.startIndex <= idx && idx <= r.endIndex);
}
