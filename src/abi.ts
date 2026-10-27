import { toWord } from './hex.ts';

// abi.encode restricted to static 32-byte types: uint256, address and bytes32.
// Every preimage in the protocol is built from these alone (PUBLIC-SPEC §3,
// §4, §5), and each encodes as one full left-padded big-endian word. The spec
// stresses this because encoding any value at a narrower width, or packed,
// changes every hash. Supporting nothing else keeps that the only path.
export function encodeWords(values: readonly bigint[]): Uint8Array {
  const out = new Uint8Array(32 * values.length);
  values.forEach((v, i) => out.set(toWord(v), 32 * i));
  return out;
}
