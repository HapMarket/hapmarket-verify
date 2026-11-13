import { createHash, getHashes } from 'node:crypto';
import { checkKeccak256 } from './keccak-selftest.ts';
import type { Keccak256 } from './keccak.ts';

// keccak256 from the platform's OpenSSL (3.2 and later, bundled with Node 24).
// This repo carries no hashing code of its own and no hashing dependency.
// Node built against an older system OpenSSL lacks it; that fails here, with
// a message, rather than at the first comparison.
//
// The known-answer self-test lives in keccak-selftest.ts, which has no node:
// imports, so a browser consumer runs the same test on the implementation it
// injects. It guards against SHA3-256 being substituted for Ethereum's keccak.
export function nodeKeccak256(): Keccak256 {
  if (!getHashes().includes('keccak-256')) {
    throw new Error(
      `this Node.js (${process.version}, OpenSSL ${process.versions.openssl}) does not provide keccak-256; ` +
        'use Node.js 24 or later with its bundled OpenSSL',
    );
  }
  const keccak: Keccak256 = (data) => new Uint8Array(createHash('keccak-256').update(data).digest());
  return checkKeccak256(keccak);
}
