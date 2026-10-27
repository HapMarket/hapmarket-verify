// Checks on the descriptor pipeline beyond the vectors.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hashDescriptor } from '../src/descriptor.ts';
import { canonicalize } from '../src/jcs.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { SchemaUnsupportedError, validate } from '../src/schema.ts';
import { parseJson } from '../src/strict-json.ts';
import { loadVectors } from './load-vectors.ts';

const keccak = nodeKeccak256();
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

// Serialize, parse, serialize again: the output must be byte-identical and
// hash to the same value. Round-trip instability is the most common way
// canonical serialization fails silently. A verifier that cannot re-read its
// own canonical form would report a mismatch on an honest descriptor.
describe('descriptor round trip', () => {
  for (const c of loadVectors('descriptor-hash').filter((v) => v.expect.outcome === 'hash')) {
    test(c.name, () => {
      const first = hashDescriptor(keccak, encode(c.inputRaw ?? JSON.stringify(c.input)));
      assert.equal(first.outcome, 'hash');
      if (first.outcome !== 'hash') return;
      const reparsed = parseJson(first.canonical, { descriptorNumbers: true });
      assert.equal(canonicalize(reparsed), first.canonical);
      const second = hashDescriptor(keccak, encode(first.canonical));
      assert.deepEqual(second, first);
    });
  }
});

describe('loader rules', () => {
  const valid = '{"schemaVersion":1,"name":"x","category":"electronics","condition":"new","images":["a"]}';

  test('a valid descriptor hashes', () => {
    assert.equal(hashDescriptor(keccak, encode(valid)).outcome, 'hash');
  });

  test('malformed UTF-8 is rejected at parse, not replaced', () => {
    const bytes = encode(valid);
    bytes[bytes.indexOf(0x78)] = 0xff; // the "x" in name
    const r = hashDescriptor(keccak, bytes);
    assert.equal(r.outcome === 'reject' && r.stage, 'parse');
  });

  test('a __proto__ key is data, not a prototype', () => {
    // It must reach the schema and be refused there as an unknown field. A
    // parser building plain objects would drop it and hash a different text.
    const r = hashDescriptor(keccak, encode(valid.replace('{', '{"__proto__":{},')));
    assert.equal(r.outcome === 'reject' && r.stage, 'schema');
  });

  test('a negative unknown version is unverifiable, not rejected', () => {
    const r = hashDescriptor(keccak, encode(valid.replace('"schemaVersion":1', '"schemaVersion":-3')));
    assert.equal(r.outcome, 'unverifiable');
  });
});

describe('schema validator', () => {
  test('an unsupported keyword is a tool fault, never a silent pass', () => {
    assert.throws(() => validate({ patternProperties: {} }, new Map()), SchemaUnsupportedError);
  });

  test('maxLength counts code points, not UTF-16 units', () => {
    // U+1F600 is one character and two UTF-16 units.
    assert.equal(validate({ maxLength: 1 }, '\u{1F600}').ok, true);
  });
});
