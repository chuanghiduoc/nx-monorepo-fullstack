import { describe, expect, it } from 'vitest';

import { SNIFF_BYTES, verifyContentType } from './content-type.js';

/**
 * A PNG signature **and its first chunk**.
 *
 * The eight-byte magic number alone is not enough: measured, `file-type`
 * returns nothing for it and reports the upload as an unrecognised format.
 * That is the detector being careful rather than broken — eight bytes that
 * happen to match are not a PNG — and it is why the sniff reads a prefix
 * rather than a header.
 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // IHDR: length, type, then a 1x1 image's fields.
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
    0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]),
]);
const PDF = Buffer.from('%PDF-1.7\n', 'ascii');
const GIF = Buffer.from('GIF89a', 'ascii');
const EXE = Buffer.from('MZ\x90\x00', 'binary');
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
const SHEBANG = Buffer.from('#!/bin/sh\nrm -rf /\n', 'ascii');
const TEXT = Buffer.from('a plain sentence, and nothing more\n', 'utf8');

/**
 * What an upload actually is.
 *
 * The declared type decides nothing — it is recorded so a rejection can name
 * both. A file that claims `image/png` and begins `MZ` is the whole reason the
 * `REJECTED` state exists, and this is where that judgement is made.
 */
describe('deciding what an upload is', () => {
  it('accepts bytes that are what they claim to be', async () => {
    expect(await verifyContentType(PNG, 'image/png')).toEqual({
      detected: 'image/png',
      matches: true,
    });
  });

  it('refuses bytes that are something else, and names both', async () => {
    const verdict = await verifyContentType(PDF, 'image/png');

    expect(verdict.matches).toBe(false);
    expect(verdict.detected).toBe('application/pdf');
    // Both types in the reason: "rejected" with no explanation is a support
    // ticket nobody can answer.
    expect(verdict.reason).toContain('image/png');
    expect(verdict.reason).toContain('application/pdf');
  });

  it('refuses an executable however it was declared', async () => {
    for (const [bytes, what] of [
      [EXE, 'executable'],
      [ELF, 'ELF'],
      [SHEBANG, 'shebang'],
    ] as const) {
      // Declared as plain text — the format with no signature, and therefore
      // the one somebody reaches for when hoping the bytes are not read.
      const verdict = await verifyContentType(bytes, 'text/plain');

      expect(verdict.matches, `${what} should be refused`).toBe(false);
      expect(verdict.reason).toMatch(/executable|ELF|script|class file/i);
    }
  });

  it('accepts a format that has no signature at all', async () => {
    // Plain text, CSV and JSON are bytes with no magic number. Treating
    // "unrecognised" as "rejected" would refuse every text file in the world.
    for (const declared of ['text/plain', 'text/csv', 'application/json']) {
      expect(
        (await verifyContentType(TEXT, declared)).matches,
        `${declared} should be accepted`,
      ).toBe(true);
    }
  });

  it('refuses unrecognised bytes that claimed to be a real format', async () => {
    // The other half of the rule above: an `image/png` with no PNG header is
    // not a PNG, and "nothing recognised it" is not a reason to accept it.
    const verdict = await verifyContentType(TEXT, 'image/png');

    expect(verdict.matches).toBe(false);
    expect(verdict.reason).toContain('no known format');
  });

  it('recognises a format from a prefix, not from the whole file', async () => {
    const large = Buffer.concat([GIF, Buffer.alloc(SNIFF_BYTES, 0x41)]);

    expect((await verifyContentType(large, 'image/gif')).matches).toBe(true);
  });

  it('refuses an empty upload that claimed a format', async () => {
    expect((await verifyContentType(Buffer.alloc(0), 'image/png')).matches).toBe(
      false,
    );
  });

  it('reads enough bytes for the detectors that need the most', () => {
    // `file-type` documents 4100 as the largest prefix any of its detectors
    // needs. Reading fewer makes a format fail to match for a reason nobody
    // would ever find.
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(4_100);
  });
});
