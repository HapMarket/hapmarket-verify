import { encodeWords } from './abi.ts';
import { bytesToBigint } from './hex.ts';
import type { Keccak256 } from './keccak.ts';

// One TicketsPurchased log, reduced to what verification reads: the buyer and
// range folded into the commitment, and the position that fixes their order
// (PUBLIC-SPEC §2).
export interface Purchase {
  buyer: bigint;
  startIndex: bigint;
  endIndex: bigint;
  blockNumber: bigint;
  logIndex: bigint;
}

// Recomputes the running hash the contract maintains, from bytes32(0):
//   c = keccak256(abi.encode(c, buyer, startIndex, endIndex))
// over purchases already in chain order (PUBLIC-SPEC §3). A match against the
// on-chain value proves the entry list rebuilt from events is exactly the one
// the contract committed to, with nothing added, dropped or reordered.
//
// totalTickets is returned alongside so that an inclusive/half-open misreading
// shows up as a wrong count as well as a wrong hash.
export function computeCommitment(
  keccak: Keccak256,
  ordered: readonly Purchase[],
): { commitment: bigint; totalTickets: bigint } {
  let commitment = 0n;
  let totalTickets = 0n;
  for (const p of ordered) {
    if (p.endIndex < p.startIndex) {
      throw new Error(`purchase at block ${p.blockNumber} log ${p.logIndex} has endIndex < startIndex`);
    }
    commitment = bytesToBigint(keccak(encodeWords([commitment, p.buyer, p.startIndex, p.endIndex])));
    // Ranges are inclusive on both ends (PUBLIC-SPEC §2).
    totalTickets += p.endIndex - p.startIndex + 1n;
  }
  return { commitment, totalTickets };
}
