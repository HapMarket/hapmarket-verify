import { bytesToBigint } from './hex.ts';
import { canonicalize } from './jcs.ts';
import type { Keccak256 } from './keccak.ts';
import { validate, type SchemaNode } from './schema.ts';
import { decodeUtf8Strict, JsonParseError, parseJson, type JsonValue } from './strict-json.ts';
import schemaV1 from '../spec-public/schema/prize-descriptor.json' with { type: 'json' };

// The prize descriptor hash (PUBLIC-SPEC §9). A market commits on-chain to
// this hash so the prize description cannot change after the fact;
// reproducing it lets anyone confirm the description they are shown is the
// one the chain committed to.

export const MAX_CANONICAL_BYTES = 16384;

export type RejectStage = 'parse' | 'schema' | 'normalization' | 'size';

// Three results that must never be collapsed. `reject` means the descriptor
// is invalid and has no hash. `unverifiable` means this tool is older than
// the descriptor; reporting it as a rejection or a mismatch would make an
// honest draw look fraudulent.
export type DescriptorResult =
  | { outcome: 'hash'; hash: bigint; canonical: string }
  | { outcome: 'reject'; stage: RejectStage; reason: string }
  | { outcome: 'unverifiable'; foundVersion: number; supportedVersions: number[] };

// Each schema version names exactly one field set. The version number is read
// from the schema file itself, so the vendored schema is the only source.
const SCHEMAS = new Map<number, SchemaNode>(
  [schemaV1 as SchemaNode].map((s) => [declaredVersion(s), s]),
);

export function supportedVersions(): number[] {
  return [...SCHEMAS.keys()].sort((a, b) => a - b);
}

// The stages run in the order PUBLIC-SPEC §9 fixes, and a descriptor is
// reported at the first stage that refuses it. Order matters: version
// dispatch must come before the schema, whose `const` would otherwise reject
// a newer version as invalid.
export function hashDescriptor(keccak: Keccak256, bytes: Uint8Array): DescriptorResult {
  // 1. parse
  let value: JsonValue;
  try {
    value = parseJson(decodeUtf8Strict(bytes), { descriptorNumbers: true });
  } catch (e) {
    if (e instanceof JsonParseError) return { outcome: 'reject', stage: 'parse', reason: e.message };
    throw e;
  }

  // 2. version dispatch. Only an integer version counts as a version; strict
  // parsing has already guaranteed any number here is an integer. Anything
  // else (missing, a string, a boolean) goes on to the schema, which rejects it.
  const version = value instanceof Map ? value.get('schemaVersion') : undefined;
  if (typeof version === 'number' && !SCHEMAS.has(version)) {
    return { outcome: 'unverifiable', foundVersion: version, supportedVersions: supportedVersions() };
  }

  // 3. schema
  const schema = SCHEMAS.get(typeof version === 'number' ? version : Math.max(...SCHEMAS.keys())) as SchemaNode;
  const validation = validate(schema, value);
  if (!validation.ok) {
    return { outcome: 'reject', stage: 'schema', reason: `${validation.path}: ${validation.message}` };
  }

  // 4. normalization. JCS does not normalize Unicode, so NFC and NFD forms of
  // the same text hash differently. A non-NFC string is rejected, never
  // normalized: normalizing would give this descriptor the hash of a
  // different text.
  const notNfc = findNonNfc(value, '$');
  if (notNfc !== undefined) return { outcome: 'reject', stage: 'normalization', reason: `${notNfc} is not NFC` };

  // 5. canonicalize, then size. The cap is in canonical UTF-8 bytes. A
  // character limit in the schema cannot bound it, since one character can
  // take up to four bytes.
  const canonical = canonicalize(value);
  const encoded = new TextEncoder().encode(canonical);
  if (encoded.length > MAX_CANONICAL_BYTES) {
    return { outcome: 'reject', stage: 'size', reason: `canonical form is ${encoded.length} bytes, over ${MAX_CANONICAL_BYTES}` };
  }

  // 6. hash
  return { outcome: 'hash', hash: bytesToBigint(keccak(encoded)), canonical };
}

function findNonNfc(value: JsonValue, path: string): string | undefined {
  if (typeof value === 'string') return value.normalize('NFC') === value ? undefined : path;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const found = findNonNfc(item, `${path}[${i}]`);
      if (found !== undefined) return found;
    }
  } else if (value instanceof Map) {
    for (const [key, child] of value) {
      if (key.normalize('NFC') !== key) return `${path} key ${JSON.stringify(key)}`;
      const found = findNonNfc(child, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function declaredVersion(schema: SchemaNode): number {
  const props = typeof schema === 'object' ? (schema['properties'] as Record<string, { const?: unknown }> | undefined) : undefined;
  const version = props?.['schemaVersion']?.const;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('vendored schema does not declare an integer schemaVersion const');
  }
  return version;
}
