import { bytesToHex } from './hex.ts';
import type { Keccak256 } from './keccak.ts';

// A known-answer self-test for a keccak256 implementation, with no dependency
// on node:crypto so it can run in a browser against whatever the consumer
// injects (the web passes viem's keccak256). It exists because Ethereum's
// keccak256 is the original Keccak submission, NOT NIST SHA3-256: the two
// differ only in padding and give different digests for every input, so
// substituting one for the other breaks every check silently. These known
// answers are Ethereum's published values; SHA3-256 fails both.
export const KECCAK256_KNOWN_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['abc', '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
];

// Runs the known answers through `keccak` and throws on any mismatch, so a
// wrong implementation fails here with a message rather than at the first
// comparison deep in a draw. Returns the same function for convenient wrapping.
export function checkKeccak256(keccak: Keccak256, label = 'keccak-256'): Keccak256 {
  for (const [input, expected] of KECCAK256_KNOWN_ANSWERS) {
    const actual = bytesToHex(keccak(new TextEncoder().encode(input)));
    if (actual !== expected) {
      throw new Error(`${label} self-test failed for ${JSON.stringify(input)}: got ${actual}, expected ${expected}`);
    }
  }
  return keccak;
}
