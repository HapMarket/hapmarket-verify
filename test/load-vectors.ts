import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VectorCase {
  name: string;
  description: string;
  input?: Record<string, unknown>;
  inputRaw?: string;
  expect: Record<string, unknown> & { outcome: string };
}

const SUBJECTS = ['commitment', 'derivation', 'descriptor-hash', 'canonicalization', 'seed'] as const;
export type Subject = (typeof SUBJECTS)[number];

// Loads one vector file from spec-public/ and refuses to hand back a file
// that cannot act as an arbiter (spec-public/vectors/FORMAT.md): one not yet
// through the two-person process, or one with no cases, would let a
// conformance run pass while checking nothing.
export function loadVectors(subject: Subject): VectorCase[] {
  const path = join(import.meta.dirname, '..', 'spec-public', 'vectors', `${subject}.json`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (file['vectorFormat'] !== 1) throw new Error(`${subject}: unsupported vectorFormat ${String(file['vectorFormat'])}`);
  if (file['subject'] !== subject) throw new Error(`${subject}: file declares subject ${String(file['subject'])}`);
  if (file['status'] !== 'complete') throw new Error(`${subject}: status is ${String(file['status'])}, not complete`);
  const cases = file['cases'];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${subject}: no cases`);
  const names = new Set<string>();
  for (const c of cases as VectorCase[]) {
    if (names.has(c.name)) throw new Error(`${subject}: duplicate case name ${c.name}`);
    names.add(c.name);
  }
  return cases as VectorCase[];
}

// Reads an input field, skipping nothing: `_`-prefixed annotations are never
// requested, which is how they are ignored.
export function field(c: VectorCase, key: string): unknown {
  if (c.input === undefined || !(key in c.input)) throw new Error(`${c.name}: input has no ${key}`);
  return c.input[key];
}

export function str(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}
