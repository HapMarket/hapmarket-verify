// The library entry (src/index.ts) must run in a browser, so nothing reachable
// from it may import a `node:` builtin, and the Node-only modules (node-keccak,
// cli) must not be reachable at all. This walks the import graph from index.ts
// and fails on either. It reads source rather than bundling, so it needs no
// build step and no dependency.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const SRC = resolve(import.meta.dirname, '..', 'src');
const ENTRY = resolve(SRC, 'index.ts');
const FORBIDDEN_MODULES = ['node-keccak.ts', 'cli.ts'];

// Every `from '...'` and bare `import '...'` specifier in a source file.
function specifiers(source: string): string[] {
  const out: string[] = [];
  const fromRe = /(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(fromRe)) out.push(m[1] as string);
  for (const m of source.matchAll(bareRe)) out.push(m[1] as string);
  return out;
}

test('index.ts reaches no node: import and no Node-only module', () => {
  const visited = new Set<string>();
  const nodeImports: string[] = [];
  const forbidden: string[] = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) {
        nodeImports.push(`${file} imports ${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue; // no external deps exist, but ignore if one appears
      const target = resolve(dirname(file), spec);
      if (FORBIDDEN_MODULES.some((m) => target.endsWith(`/${m}`))) forbidden.push(`${file} imports ${spec}`);
      queue.push(target);
    }
  }
  assert.deepEqual(nodeImports, [], `library entry reaches node: imports:\n${nodeImports.join('\n')}`);
  assert.deepEqual(forbidden, [], `library entry reaches Node-only modules:\n${forbidden.join('\n')}`);
  // A guard against the walk silently finding nothing.
  assert.ok(visited.size > 5, `only walked ${visited.size} files`);
});
