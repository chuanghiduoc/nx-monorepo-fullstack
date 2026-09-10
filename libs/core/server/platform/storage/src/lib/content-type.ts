import { fileTypeFromBuffer } from 'file-type';

/**
 * How many bytes are enough to recognise a format.
 *
 * `file-type` documents 4100 as the largest prefix any of its detectors needs.
 * Reading more is waste; reading less makes a format fail to match for a
 * reason nobody would find.
 */
export const SNIFF_BYTES = 4_100;

export interface TypeVerdict {
  /** What the bytes are, or `undefined` when nothing recognised them. */
  readonly detected?: string;
  readonly matches: boolean;
  /** Why it did not match, ready to store on the record. */
  readonly reason?: string;
}

/**
 * Formats that legitimately have no signature.
 *
 * Plain text, CSV, JSON and SVG are bytes with no magic number, so
 * `file-type` returns nothing for them — correctly. Treating "unrecognised"
 * as "rejected" would refuse every text file in the world; treating it as
 * "fine" would accept an executable that claimed to be text.
 *
 * The compromise is narrow and deliberate: an unrecognised file is accepted
 * **only** when it was declared as one of these, and even then the bytes are
 * checked for the signatures that matter most.
 */
const SIGNATURE_FREE = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'image/svg+xml',
  'text/html',
]);

/**
 * Signatures worth refusing whatever a caller declared.
 *
 * A Windows executable begins `MZ`; an ELF binary begins `\x7fELF`; a shell
 * script begins `#!`. None of them is `text/plain`, and all three are what
 * somebody uploads when they are hoping a text file is not read closely.
 */
const ALWAYS_REFUSED: readonly { readonly prefix: Buffer; readonly what: string }[] =
  [
    { prefix: Buffer.from('MZ', 'ascii'), what: 'a Windows executable' },
    { prefix: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), what: 'an ELF binary' },
    { prefix: Buffer.from('#!', 'ascii'), what: 'a script with a shebang' },
    { prefix: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), what: 'a Java class file' },
  ];

/**
 * What the bytes actually are, against what the caller said.
 *
 * **The declared type decides nothing.** It is recorded so a rejection can
 * name both, and that is all it is for. A file that claims `image/png` and
 * begins `MZ` is the reason the `REJECTED` state exists.
 */
export async function verifyContentType(
  prefix: Buffer,
  declared: string,
): Promise<TypeVerdict> {
  for (const refused of ALWAYS_REFUSED) {
    if (prefix.subarray(0, refused.prefix.length).equals(refused.prefix)) {
      return {
        matches: false,
        reason: `The bytes are ${refused.what}, whatever the upload declared (${declared}).`,
      };
    }
  }

  const found = await fileTypeFromBuffer(prefix);

  if (found === undefined) {
    // Nothing recognised it. Fine for a format that has no signature, and not
    // fine for anything else — a declared `image/png` with no PNG header is a
    // file that is not a PNG.
    if (SIGNATURE_FREE.has(declared)) {
      return { matches: true };
    }

    return {
      matches: false,
      reason: `The upload declared ${declared}, and the bytes match no known format.`,
    };
  }

  if (found.mime === declared) {
    return { detected: found.mime, matches: true };
  }

  return {
    detected: found.mime,
    matches: false,
    reason: `The upload declared ${declared} and the bytes are ${found.mime}.`,
  };
}
