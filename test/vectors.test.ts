// Conformance against spec-public/vectors. The vectors were computed from the
// spec prose by two people before any implementation existed, so they are the
// arbiter between this verifier and the contract. A failure here means this
// code or the spec is wrong. It never means the vector should change.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeCommitment, type Purchase } from '../src/commitment.ts';
import { deriveIndex, type Range } from '../src/derivation.ts';
import { hashDescriptor } from '../src/descriptor.ts';
import { orderPurchases } from '../src/events.ts';
import { bytesToHex, hex32, parseDecimal, parseFixedHex } from '../src/hex.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { seedFromOutputSeed } from '../src/seed.ts';
import { canonicalize } from '../src/jcs.ts';
import { parseJson } from '../src/strict-json.ts';
import { field, loadVectors, str, type VectorCase } from './load-vectors.ts';

const keccak = nodeKeccak256();

describe('seed vectors', () => {
  for (const c of loadVectors('seed')) {
    test(c.name, () => {
      assert.equal(c.expect.outcome, 'seed');
      const { seed, preimage } = seedFromOutputSeed(keccak, parseFixedHex(str(field(c, 'outputSeed'), 'outputSeed'), 32));
      // Preimage first: it localises a failure to encoding rather than hashing.
      assert.equal(bytesToHex(preimage), c.expect['preimage']);
      assert.equal(hex32(seed), c.expect['value']);
    });
  }
});

describe('commitment vectors', () => {
  for (const c of loadVectors('commitment')) {
    test(c.name, () => {
      assert.equal(c.expect.outcome, 'commitment');
      const purchases = (field(c, 'purchases') as Record<string, unknown>[]).map(
        (p): Purchase => ({
          buyer: parseFixedHex(str(p['buyer'], 'buyer'), 20),
          startIndex: parseDecimal(str(p['startIndex'], 'startIndex')),
          endIndex: parseDecimal(str(p['endIndex'], 'endIndex')),
          blockNumber: parseDecimal(str(p['block'], 'block')),
          logIndex: parseDecimal(str(p['logIndex'], 'logIndex')),
        }),
      );
      const { commitment, totalTickets } = computeCommitment(keccak, orderPurchases(purchases));
      assert.equal(totalTickets.toString(), c.expect['totalTickets']);
      assert.equal(hex32(commitment), c.expect['value']);
    });
  }
});

describe('derivation vectors', () => {
  for (const c of loadVectors('derivation')) {
    test(c.name, () => {
      const excluded = (field(c, 'excluded') as Record<string, unknown>[]).map(
        (r): Range => ({
          startIndex: parseDecimal(str(r['startIndex'], 'startIndex')),
          endIndex: parseDecimal(str(r['endIndex'], 'endIndex')),
        }),
      );
      const result = deriveIndex(
        keccak,
        parseFixedHex(str(field(c, 'seed'), 'seed'), 32),
        parseDecimal(str(field(c, 'roundId'), 'roundId')),
        parseDecimal(str(field(c, 'drawNonce'), 'drawNonce')),
        parseDecimal(str(field(c, 'totalTickets'), 'totalTickets')),
        excluded,
      );
      assert.equal(result.outcome, c.expect.outcome);
      assert.equal(result.attempts.toString(), c.expect['attempts']);
      if (result.outcome === 'index') assert.equal(result.index.toString(), c.expect['value']);
      else assert.equal(result.error, c.expect['error']);
    });
  }
});

// Descriptor cases run the whole pipeline from text, as a verifier would.
// parse-stage cases carry the literal text in inputRaw, since parsing the
// fixture first would erase what they test (1.0 vs 1); the rest are
// re-serialized from parsed JSON, which preserves every string code point
// and integer they contain.
function descriptorText(c: VectorCase): string {
  return c.inputRaw ?? JSON.stringify(c.input);
}

describe('descriptor-hash vectors', () => {
  for (const c of loadVectors('descriptor-hash')) {
    test(c.name, () => {
      const result = hashDescriptor(keccak, new TextEncoder().encode(descriptorText(c)));
      // The outcome and, for a reject, the stage are both part of the
      // assertion: refused at the wrong stage is a defect, not a pass.
      assert.equal(result.outcome, c.expect.outcome, result.outcome === 'reject' ? result.reason : undefined);
      if (result.outcome === 'hash') {
        assert.equal(result.canonical, c.expect['canonical']);
        assert.equal(hex32(result.hash), c.expect['value']);
      } else if (result.outcome === 'reject') {
        assert.equal(result.stage, c.expect['stage'], result.reason);
      } else {
        assert.equal(result.foundVersion, c.expect['foundVersion']);
        assert.deepEqual(result.supportedVersions, c.expect['supportedVersions']);
      }
    });
  }
});

describe('canonicalization vectors', () => {
  for (const c of loadVectors('canonicalization')) {
    test(c.name, () => {
      assert.equal(c.expect.outcome, 'canonical');
      const text = c.inputRaw ?? JSON.stringify(c.input);
      assert.equal(canonicalize(parseJson(text, { descriptorNumbers: false })), c.expect['value']);
    });
  }
});
