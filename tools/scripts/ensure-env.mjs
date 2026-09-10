import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const template = join(workspaceRoot, '.env.example');
const target = join(workspaceRoot, '.env');

/**
 * Gives a checkout the configuration `pnpm dev` needs.
 *
 * The services validate their environment at boot and refuse to start without
 * it, so without this the documented first command fails on a machine that has
 * done nothing wrong. Copying the template matches the defaults in
 * `docker-compose.yml`, which is what the same command is about to start.
 *
 * An existing file is never overwritten: it holds whatever this machine
 * actually uses, and replacing it would throw away real credentials. But it is
 * topped up. A variable added to the template after somebody's `.env` was
 * created would otherwise never reach them — the file exists, so the old
 * version of this script stopped — and they would meet the new variable as a
 * boot failure on a machine that was working yesterday.
 */
if (!existsSync(template)) {
  console.error('.env.example is missing; cannot create .env from it.');
  process.exit(1);
}

if (!existsSync(target)) {
  copyFileSync(template, target);
  console.log('Created .env from .env.example. Edit it if this machine differs.');
  process.exit(0);
}

/**
 * Every variable a file has an opinion about, including the ones it has
 * commented out.
 *
 * `# HOST=127.0.0.1` in somebody's `.env` is a decision — they turned it off —
 * and appending the template's line underneath would silently turn it back on,
 * because dotenv takes the last assignment. Only the target is read this way;
 * the template is scanned below with a stricter pattern, so an example it
 * leaves commented out is not treated as a variable at all.
 */
function namesIn(contents) {
  const names = new Set();

  for (const line of contents.split(/\r?\n/)) {
    const assignment = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (assignment) {
      names.add(assignment[1]);
    }
  }

  return names;
}

const templateContents = readFileSync(template, 'utf8');
const existing = namesIn(readFileSync(target, 'utf8'));

// The template's own line for each missing variable, so the value and the
// comment above it arrive together rather than as a bare name.
const additions = [];
let pending = [];

for (const line of templateContents.split(/\r?\n/)) {
  const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);

  if (!assignment) {
    // Comments and blanks belong to whatever assignment comes next.
    pending = line.trim() === '' ? [] : [...pending, line];
    continue;
  }

  if (!existing.has(assignment[1])) {
    additions.push(...pending, line);
  }

  pending = [];
}

if (additions.length === 0) {
  process.exit(0);
}

appendFileSync(
  target,
  `\n# Added by ensure-env because .env.example gained them.\n${additions.join('\n')}\n`,
  'utf8',
);

const added = additions.filter((line) => /^\s*[A-Za-z_]/.test(line)).length;
console.log(`Added ${added} new variable(s) to .env from .env.example.`);
