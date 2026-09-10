import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// src -> workspace-plugin -> tools -> the workspace root.
const workspaceRoot = join(import.meta.dirname, '..', '..', '..');

const CARRIAGE_RETURN = '\r';

/**
 * Files whose first line is read by a program that cannot tolerate a carriage
 * return. A shell reads `#!/bin/sh\r` as a request for an interpreter named
 * `/bin/sh\r`, which does not exist, and reports
 * `bad interpreter: /bin/sh^M: No such file or directory` — a message that
 * names neither the file nor the real cause.
 */
const MUST_BE_LF = /\.sh$/;

/**
 * Line endings in files that are executed rather than read.
 *
 * `.gitattributes` normalises the repository to LF on commit, so this can only
 * ever be wrong in a working tree — which is precisely where it is hardest to
 * see, and where it costs the most: a shell script rewritten in place by a
 * tool that defaults to the platform's line ending stops being runnable inside
 * a Linux container, and the failure surfaces as a database whose roles have
 * no password rather than as anything about a file.
 *
 * It happened once. This is what makes it fail here instead of there.
 */
describe('files a shell has to execute', () => {
  it('have no carriage returns', () => {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter((path) => MUST_BE_LF.test(path));

    // A guard with nothing to guard would pass for the wrong reason.
    expect(tracked.length).toBeGreaterThan(0);

    const offenders = tracked.filter((path) =>
      readFileSync(join(workspaceRoot, path), 'utf8').includes(CARRIAGE_RETURN),
    );

    expect(offenders).toEqual([]);
  });
});

/** Extensions whose contents a person is expected to read. */
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|sql|sh|css)$/;

/**
 * A source file that no tool will show you.
 *
 * Git classifies a file as binary by looking for a NUL byte near its start,
 * and everything downstream follows: `git diff` prints "Binary files differ"
 * instead of the change, `grep` refuses to print a match, and `text=auto` in
 * `.gitattributes` stops normalising the line endings — so the file quietly
 * keeps whichever ones the last tool to write it chose.
 *
 * It happened twice, in a driver that used NUL to separate two halves of a map
 * key and in the test for a redirect guard that passed one as a hostile input.
 * Both meant it; neither meant to make the file unreviewable, and nothing
 * reported that they had. `'\\u0000'` says exactly the same thing to the
 * compiler and nothing at all to git.
 */
describe('source files a review has to be able to read', () => {
  it('contain no NUL bytes', () => {
    // `-c -o --exclude-standard` is committed files plus the ones not yet
    // committed, minus what is ignored: a file is at its most reviewable
    // before it is committed, which is exactly when this should fail.
    const paths = execFileSync(
      'git',
      ['ls-files', '-c', '-o', '--exclude-standard'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    )
      .split('\n')
      .filter((path) => SOURCE.test(path))
      // A file deleted but not yet committed is still in the index, and
      // reading it throws ENOENT — a failure about the wrong thing entirely.
      .filter((path) => existsSync(join(workspaceRoot, path)));

    expect(paths.length).toBeGreaterThan(0);

    const offenders = paths.filter((path) =>
      readFileSync(join(workspaceRoot, path)).includes(0),
    );

    expect(offenders).toEqual([]);
  });
});
