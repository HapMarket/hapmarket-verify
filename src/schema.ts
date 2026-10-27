import type { JsonValue } from './strict-json.ts';

// A JSON Schema (draft 2020-12) validator for exactly the keywords
// spec-public/schema/prize-descriptor.json uses, applied to that file as
// published.
//
// It reads the schema rather than hard-coding its rules because enum values
// are append-only and are added WITHOUT a schemaVersion bump (PUBLIC-SPEC §9).
// A hard-coded copy would go stale on the next append and reject an honest
// descriptor, which looks exactly like a tampered one.
//
// Any keyword outside the supported set throws SchemaUnsupportedError. That
// is a fault in this tool, reported as such, never as a rejected descriptor:
// silently skipping an unknown keyword would accept inputs the schema forbids.

export type SchemaNode = boolean | { readonly [keyword: string]: unknown };

export class SchemaUnsupportedError extends Error {}

export type Validation = { ok: true } | { ok: false; path: string; message: string };

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', '$defs']);

export function validate(root: SchemaNode, instance: JsonValue): Validation {
  const resolve = (ref: string): SchemaNode => {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
    const defs = typeof root === 'object' ? (root['$defs'] as Record<string, SchemaNode> | undefined) : undefined;
    const target = m === null ? undefined : defs?.[m[1] as string];
    if (target === undefined) throw new SchemaUnsupportedError(`unsupported or unresolvable $ref ${ref}`);
    return target;
  };

  const check = (schema: SchemaNode, value: JsonValue, path: string): Validation => {
    if (schema === true) return { ok: true };
    if (schema === false) return { ok: false, path, message: 'no value is allowed here' };
    const bad = (message: string): Validation => ({ ok: false, path, message });

    for (const [keyword, arg] of Object.entries(schema)) {
      if (ANNOTATIONS.has(keyword)) continue;
      let result: Validation = { ok: true };
      switch (keyword) {
        case 'type': {
          const types = Array.isArray(arg) ? (arg as string[]) : [arg as string];
          if (!types.some((t) => hasType(value, t))) result = bad(`expected type ${types.join(' or ')}, got ${typeName(value)}`);
          break;
        }
        case 'const':
          if (!sameValue(value, arg)) result = bad(`must equal ${JSON.stringify(arg)}`);
          break;
        case 'enum':
          if (!(arg as unknown[]).some((e) => sameValue(value, e))) result = bad(`must be one of ${JSON.stringify(arg)}`);
          break;
        case '$ref':
          result = check(resolve(arg as string), value, path);
          break;
        case 'allOf':
          for (const sub of arg as SchemaNode[]) {
            result = check(sub, value, path);
            if (!result.ok) break;
          }
          break;
        case 'minLength':
        case 'maxLength':
        case 'pattern':
          if (typeof value === 'string') result = checkString(keyword, arg, value, bad);
          break;
        case 'items':
        case 'minItems':
        case 'maxItems':
        case 'uniqueItems':
          if (Array.isArray(value)) result = checkArray(keyword, arg, value, path, bad, check);
          break;
        case 'properties':
        case 'additionalProperties':
        case 'propertyNames':
        case 'required':
        case 'maxProperties':
        case 'minProperties':
          if (value instanceof Map) result = checkObject(keyword, arg, schema, value, path, bad, check);
          break;
        case 'minimum':
          if (typeof value === 'number' && value < (arg as number)) result = bad(`must be >= ${String(arg)}`);
          break;
        case 'maximum':
          if (typeof value === 'number' && value > (arg as number)) result = bad(`must be <= ${String(arg)}`);
          break;
        default:
          throw new SchemaUnsupportedError(`schema keyword ${keyword} at ${path} is not supported by this validator`);
      }
      if (!result.ok) return result;
    }
    return { ok: true };
  };

  return check(root, instance, '$');
}

type Check = (schema: SchemaNode, value: JsonValue, path: string) => Validation;
type Bad = (message: string) => Validation;

function checkString(keyword: string, arg: unknown, value: string, bad: Bad): Validation {
  // JSON Schema counts characters as Unicode code points, not UTF-16 units.
  const length = [...value].length;
  if (keyword === 'minLength' && length < (arg as number)) return bad(`shorter than ${String(arg)} characters`);
  if (keyword === 'maxLength' && length > (arg as number)) return bad(`longer than ${String(arg)} characters`);
  // Patterns are ECMA-262 regular expressions and are not implicitly anchored.
  if (keyword === 'pattern' && !new RegExp(arg as string, 'u').test(value)) return bad(`does not match ${String(arg)}`);
  return { ok: true };
}

function checkArray(keyword: string, arg: unknown, value: JsonValue[], path: string, bad: Bad, check: Check): Validation {
  if (keyword === 'minItems' && value.length < (arg as number)) return bad(`fewer than ${String(arg)} items`);
  if (keyword === 'maxItems' && value.length > (arg as number)) return bad(`more than ${String(arg)} items`);
  if (keyword === 'uniqueItems' && arg === true) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (sameValue(value[i] as JsonValue, value[j])) return bad(`items ${i} and ${j} are equal`);
      }
    }
  }
  if (keyword === 'items') {
    for (const [i, item] of value.entries()) {
      const r = check(arg as SchemaNode, item, `${path}[${i}]`);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

function checkObject(
  keyword: string,
  arg: unknown,
  schema: { readonly [keyword: string]: unknown },
  value: Map<string, JsonValue>,
  path: string,
  bad: Bad,
  check: Check,
): Validation {
  const properties = (schema['properties'] ?? {}) as Record<string, SchemaNode>;
  if (keyword === 'required') {
    for (const key of arg as string[]) if (!value.has(key)) return bad(`missing required property ${key}`);
  }
  if (keyword === 'maxProperties' && value.size > (arg as number)) return bad(`more than ${String(arg)} properties`);
  if (keyword === 'minProperties' && value.size < (arg as number)) return bad(`fewer than ${String(arg)} properties`);
  for (const [key, child] of value) {
    const childPath = `${path}.${key}`;
    let r: Validation = { ok: true };
    if (keyword === 'propertyNames') r = check(arg as SchemaNode, key, `${path} key ${JSON.stringify(key)}`);
    if (keyword === 'properties' && Object.hasOwn(properties, key)) r = check(properties[key] as SchemaNode, child, childPath);
    if (keyword === 'additionalProperties' && !Object.hasOwn(properties, key)) r = check(arg as SchemaNode, child, childPath);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function hasType(value: JsonValue, type: string): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    // JSON Schema's integer is any number with no fractional part, so 1.0 is
    // one. That is why the no-float rule is enforced by the parser instead.
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return value instanceof Map;
    default: throw new SchemaUnsupportedError(`unknown type ${type}`);
  }
}

function typeName(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Map) return 'object';
  return typeof value;
}

// JSON equality between a parsed instance (objects as Maps) and either
// another instance or a value written in the schema (objects as plain
// objects). Object key order does not matter, as in JSON Schema.
function sameValue(a: JsonValue, b: unknown): boolean {
  if (a === null || typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  let entries: [string, unknown][];
  if (b instanceof Map) entries = [...b.entries()];
  else if (typeof b === 'object' && b !== null && !Array.isArray(b)) entries = Object.entries(b);
  else return false;
  return entries.length === a.size && entries.every(([k, v]) => a.has(k) && sameValue(a.get(k) as JsonValue, v));
}
