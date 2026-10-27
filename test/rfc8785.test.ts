// The published RFC 8785 conformance suite, run unchanged. The vectors in
// spec-public cover the protocol's own constraints; this suite is the only
// external check that the canonicalizer implements the standard itself.
// Expected outputs are compared as raw bytes, since canonical form is a
// statement about bytes.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { canonicalize } from '../src/jcs.ts';
import { decodeUtf8Strict, parseJson } from '../src/strict-json.ts';

const DIR = join(import.meta.dirname, 'rfc8785');

describe('RFC 8785 conformance suite', () => {
  const names = readdirSync(join(DIR, 'input')).filter((f) => f.endsWith('.json'));
  assert.ok(names.length > 0, 'conformance suite is missing');
  for (const name of names) {
    test(name, () => {
      const input = decodeUtf8Strict(readFileSync(join(DIR, 'input', name)));
      const expected = readFileSync(join(DIR, 'output', name));
      const actual = new TextEncoder().encode(canonicalize(parseJson(input, { descriptorNumbers: false })));
      assert.deepEqual(Buffer.from(actual), expected);
    });
  }
});
