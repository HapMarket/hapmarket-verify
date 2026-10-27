import type { JsonValue } from './strict-json.ts';

// RFC 8785, JSON Canonicalization Scheme, complete. It canonicalizes any JSON
// value, floats and null included. The descriptor's extra constraints are
// enforced in a validating layer above it (descriptor.ts), never here: a
// canonicalizer narrowed to descriptors could not run the published RFC 8785
// conformance suite, which is the only external check on this code.
//
// RFC 8785 defines its output in terms of ECMAScript's JSON serialization,
// so the platform's own primitives are the specified behaviour here, not an
// approximation of it:
//   - numbers (§3.2.2.3): ECMAScript Number serialization, which
//     JSON.stringify applies to a number, including -0 to "0";
//   - strings (§3.2.2.2): JSON.stringify's escaping, which for well-formed
//     strings is exactly the set the RFC prescribes;
//   - key order (§3.2.3): by UTF-16 code unit, which is what Array.prototype.sort
//     does with no comparator.
export function canonicalize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS cannot represent NaN or Infinity');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = [...value.keys()].sort();
  return '{' + keys.map((k) => canonicalString(k) + ':' + canonicalize(value.get(k) as JsonValue)).join(',') + '}';
}

function canonicalString(s: string): string {
  // JSON.stringify would escape a lone surrogate rather than fail, but RFC 8785
  // requires I-JSON input, in which it cannot occur.
  if (!s.isWellFormed()) throw new Error('JCS cannot represent a string that is not well-formed Unicode');
  return JSON.stringify(s);
}
