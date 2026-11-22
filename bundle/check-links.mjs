#!/usr/bin/env node
// Bundle guard: fail if package.json or pnpm-workspace.yaml carries a `link:`
// dependency or override.
//
// Upstream CourtHive repositories point their sibling packages at local
// checkouts (`link:../factory` and so on). A build that keeps one of those
// either fails or, worse, bundles whatever happens to sit in a neighbouring
// directory. The bundle image must be built from published packages only, so
// the Dockerfile and the bundle CI workflow both run this before installing.
//
// Usage: node bundle/check-links.mjs [directory]   (default: current directory)
// No dependencies: runs before `pnpm install`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || '.';
const problems = [];

// package.json: any string value starting with `link:` anywhere in the
// dependency maps, pnpm.overrides, resolutions and so on.
const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`bundle guard: ${pkgPath} not found`);
  process.exit(2);
}
const walk = (value, trail) => {
  if (typeof value === 'string') {
    if (value.trim().startsWith('link:')) problems.push(`package.json ${trail.join('.')}: ${value}`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'scripts') walk(v, [...trail, k]);
    }
  }
};
walk(JSON.parse(readFileSync(pkgPath, 'utf8')), []);

// pnpm-workspace.yaml: no YAML parser available before install, so strip
// comments (a `#` at line start or after whitespace, outside quotes is close
// enough for this file) and look for `link:` as a value.
const wsPath = join(root, 'pnpm-workspace.yaml');
if (existsSync(wsPath)) {
  readFileSync(wsPath, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const code = line.replace(/(^|\s)#.*$/, '');
      if (/(^|[\s'":])link:/.test(code.replace(/^\s*[^:]+:\s*/, ' '))) {
        problems.push(`pnpm-workspace.yaml line ${i + 1}: ${line.trim()}`);
      }
    });
}

if (problems.length) {
  console.error('bundle guard: link: dependencies or overrides found. The bundle image must use');
  console.error('published packages only. Remove these lines (see BUNDLE.md, "Moving to a newer upstream"):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('bundle guard: no link: dependencies or overrides');
