// Maintains spec-public/, the committed copy of the public subset of the
// private spec repository.
//
//   node scripts/spec-public.ts sync <path-to-spec-repo>
//       Copy the public subset in and rewrite CHECKSUMS. A sync is a
//       deliberate commit, never an automated push: an upstream change must
//       not silently alter a published artefact.
//
//   node scripts/spec-public.ts check [--source <path-to-spec-repo>]
//       Confirm every vendored file matches CHECKSUMS and nothing else is
//       present. With --source (CI, which can read the private repo), also
//       confirm the copies match upstream byte for byte.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEST = join(import.meta.dirname, '..', 'spec-public');

// The public subset. Anything not listed here stays private.
function publicFiles(root: string): string[] {
  const vectors = readdirSync(join(root, 'vectors'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => `vectors/${f}`);
  return [
    'PUBLIC-SPEC.md',
    'schema/prize-descriptor.json',
    'schema/CANONICAL.md',
    'vectors/FORMAT.md',
    ...vectors,
  ].sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listTree(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    return e.isDirectory() ? listTree(root, rel) : [rel];
  });
}

function sync(source: string): void {
  const files = publicFiles(source);
  const lines = files.map((f) => {
    mkdirSync(dirname(join(DEST, f)), { recursive: true });
    copyFileSync(join(source, f), join(DEST, f));
    return `${sha256(join(DEST, f))}  ${f}`;
  });
  writeFileSync(join(DEST, 'CHECKSUMS'), lines.join('\n') + '\n');
  console.log(`synced ${files.length} files into spec-public/`);
}

function check(source: string | undefined): void {
  const failures: string[] = [];
  const listed = new Map<string, string>();
  for (const line of readFileSync(join(DEST, 'CHECKSUMS'), 'utf8').trimEnd().split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (m === null) {
      failures.push(`malformed CHECKSUMS line: ${line}`);
      continue;
    }
    listed.set(m[2] as string, m[1] as string);
  }

  const present = listTree(DEST).filter((f) => f !== 'CHECKSUMS').sort();
  for (const f of present) {
    const expected = listed.get(f);
    if (expected === undefined) failures.push(`${f}: present but not in CHECKSUMS`);
    else if (sha256(join(DEST, f)) !== expected) failures.push(`${f}: does not match CHECKSUMS`);
  }
  for (const f of listed.keys()) {
    if (!present.includes(f)) failures.push(`${f}: in CHECKSUMS but missing`);
  }

  if (source !== undefined) {
    const upstream = publicFiles(source);
    for (const f of upstream) {
      if (!listed.has(f)) failures.push(`${f}: published upstream but not vendored`);
      else if (sha256(join(source, f)) !== listed.get(f)) failures.push(`${f}: stale, upstream has changed`);
    }
    for (const f of listed.keys()) {
      if (!upstream.includes(f)) failures.push(`${f}: vendored but no longer published upstream`);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`spec-public: ${listed.size} files match CHECKSUMS${source === undefined ? '' : ' and upstream'}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'sync' && args.length === 1) {
  sync(args[0] as string);
} else if (command === 'check' && args.length === 0) {
  check(undefined);
} else if (command === 'check' && args.length === 2 && args[0] === '--source') {
  check(args[1]);
} else {
  console.error('usage: spec-public.ts sync <spec-repo> | check [--source <spec-repo>]');
  process.exit(2);
}
