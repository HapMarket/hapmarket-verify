import { encodeWords } from './abi.ts';
import { bytesToBigint } from './hex.ts';
import type { Keccak256 } from './keccak.ts';

// The seed a draw used must be the one Chainlink's coordinator delivered.
// The coordinator logs `outputSeed` (the verified VRF output) in
// RandomWordsFulfilled and hands the consumer
// uint256(keccak256(abi.encode(outputSeed, 0))): word i of the request, and
// the core requests exactly one word (PUBLIC-SPEC §4). Recomputing it here is
// what links the seed in RandomnessFulfilled to a VRF proof that the
// coordinator verified on-chain.
export function seedFromOutputSeed(keccak: Keccak256, outputSeed: bigint): { seed: bigint; preimage: Uint8Array } {
  const preimage = encodeWords([outputSeed, 0n]);
  return { seed: bytesToBigint(keccak(preimage)), preimage };
}
