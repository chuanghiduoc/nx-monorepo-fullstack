/**
 * How many characters one passage holds, and how much of it the next repeats.
 *
 * Characters rather than tokens, and a fixed size rather than a structural
 * one. Both are compromises and the contract says so: a real ingest splits on
 * headings and sentences, counts tokens with the model's own tokeniser, and
 * measures whether the answers got better. This one is here so the parts
 * connect.
 */
const CHUNK_CHARACTERS = 1_200;
const OVERLAP_CHARACTERS = 150;

/**
 * Cuts a document into overlapping passages.
 *
 * The overlap is the only part of this worth defending: a sentence that
 * straddles a boundary is otherwise in neither passage in one piece, and the
 * answer that needed it retrieves half of it.
 *
 * Whitespace-only passages are dropped. Embedding one costs a request and
 * returns a vector that is near everything, which is worse than not having it.
 */
export function intoPassages(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n').trim();

  if (normalised.length === 0) {
    return [];
  }

  const passages: string[] = [];
  const stride = CHUNK_CHARACTERS - OVERLAP_CHARACTERS;

  for (let start = 0; start < normalised.length; start += stride) {
    const passage = normalised.slice(start, start + CHUNK_CHARACTERS).trim();

    if (passage.length > 0) {
      passages.push(passage);
    }

    // The last window reached the end, so a further stride would produce a
    // passage that is entirely overlap — the same text, embedded twice, and
    // retrieved twice as though two sources agreed.
    if (start + CHUNK_CHARACTERS >= normalised.length) {
      break;
    }
  }

  return passages;
}

export const PASSAGE_CHARACTERS = CHUNK_CHARACTERS;
export const PASSAGE_OVERLAP = OVERLAP_CHARACTERS;
