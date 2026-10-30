/**
 * Pure, deterministic, I/O-free text statistics.
 *
 * Contract (see published interfaces):
 * - `characters`: Unicode code-point count (not UTF-16 code units, not bytes).
 *   Whitespace and line-ending characters are included.
 * - `words`: count of maximal runs of non-whitespace characters.
 * - `lines`: LF-separated records. Empty input -> 0. A final LF terminates the
 *   last record without adding an extra line. CRLF separates lines via its LF;
 *   both CR and LF count as characters. Blank lines count as lines.
 *
 * `computeStats` is total: it never throws for any string input and does not
 * mutate it.
 */

export interface Stats {
  lines: number;
  words: number;
  characters: number;
}

/** Whitespace predicate matching the ECMAScript `\s` class semantics. */
function isWhitespace(codePoint: number): boolean {
  // Fast paths for the common ASCII cases.
  if (codePoint === 0x20 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x09) {
    return true;
  }
  if (codePoint < 0x09) {
    return false;
  }
  switch (codePoint) {
    case 0x0b: // vertical tab
    case 0x0c: // form feed
    case 0x00a0: // no-break space
    case 0x1680: // ogham space mark
    case 0x2028: // line separator
    case 0x2029: // paragraph separator
    case 0x202f: // narrow no-break space
    case 0x205f: // medium mathematical space
    case 0x3000: // ideographic space
    case 0xfeff: // zero width no-break space (as matched by \s)
      return true;
    default:
      return codePoint >= 0x2000 && codePoint <= 0x200a;
  }
}

/**
 * Count statistics for the given text.
 *
 * Implemented as a single linear scan over Unicode code points so that
 * surrogate pairs are counted once.
 */
export function computeStats(text: string): Stats {
  let characters = 0;
  let words = 0;
  let lines = 0;
  let inWord = false;

  if (text.length === 0) {
    return { lines: 0, words: 0, characters: 0 };
  }

  for (const char of text) {
    characters += 1;
    const codePoint = char.codePointAt(0) as number;

    if (codePoint === 0x0a) {
      // LF terminates a record; a trailing LF is handled below by not
      // double-counting, and an interior LF always advances the line count.
      lines += 1;
    }

    if (isWhitespace(codePoint)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words += 1;
    }
  }

  // Every LF starts a new record; if the text does not end with LF the final
  // (unterminated) record must be counted as well.
  if (!text.endsWith('\n')) {
    lines += 1;
  }

  return { lines, words, characters };
}
