import { createHash, getHashes } from 'node:crypto';
import { bytesToHex } from './hex.ts';
import type { Keccak256 } from './keccak.ts';

// Ethereum's keccak256 is the original Keccak submission, NOT NIST SHA3-256.
// They differ only in padding and give different digests for every input, so
// substituting one for the other breaks every check silently. These known
// answers are Ethereum's published values; SHA3-256 fails both.
const KNOWN_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['abc', '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
];

// keccak256 from the platform's OpenSSL (3.2 and later, bundled with Node 24).
// This repo carries no hashing code of its own and no hashing dependency.
// Node built against an older system OpenSSL lacks it; that fails here, with
// a message, rather than at the first comparison.
export function nodeKeccak256(): Keccak256 {
  if (!getHashes().includes('keccak-256')) {
    throw new Error(
      `this Node.js (${process.version}, OpenSSL ${process.versions.openssl}) does not provide keccak-256; ` +
        'use Node.js 24 or later with its bundled OpenSSL',
    );
  }
  const keccak: Keccak256 = (data) => new Uint8Array(createHash('keccak-256').update(data).digest());
  for (const [input, expected] of KNOWN_ANSWERS) {
    const actual = bytesToHex(keccak(new TextEncoder().encode(input)));
    if (actual !== expected) {
      throw new Error(`keccak-256 self-test failed for ${JSON.stringify(input)}: got ${actual}, expected ${expected}`);
    }
  }
  return keccak;
}
