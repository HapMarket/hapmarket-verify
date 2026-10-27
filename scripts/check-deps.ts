// Enforces the dependency ceiling. Every dependency is attack surface and a
// reason to distrust the verifier's output, so the ceiling is a security
// property, not a style rule. Raising it is a deliberate, reviewed change.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_RUNTIME = 0;
const MAX_DEV = 2;

const pkg: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function names(field: string): string[] {
  if (typeof pkg !== 'object' || pkg === null) return [];
  const deps: unknown = (pkg as Record<string, unknown>)[field];
  return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
}

const runtime = [...names('dependencies'), ...names('optionalDependencies'), ...names('peerDependencies')];
const dev = names('devDependencies');

let failed = false;
if (runtime.length > MAX_RUNTIME) {
  console.error(`runtime dependencies: ${runtime.length} > ceiling ${MAX_RUNTIME} (${runtime.join(', ')})`);
  failed = true;
}
if (dev.length > MAX_DEV) {
  console.error(`dev dependencies: ${dev.length} > ceiling ${MAX_DEV} (${dev.join(', ')})`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`dependencies: ${runtime.length} runtime (ceiling ${MAX_RUNTIME}), ${dev.length} dev (ceiling ${MAX_DEV})`);
