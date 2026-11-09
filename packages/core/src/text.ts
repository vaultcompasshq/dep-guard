// A JSON or YAML file the scan reads may start with a UTF-8 byte order
// mark; npm and pnpm read such a file, so every parser here removes it
// first. One helper, so no parse site is left out.
export function withoutByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

// Every C0 and C1 control character (the ESC that starts an ANSI sequence
// included), the Unicode bidi controls (U+202A-202E, U+2066-2069) and the
// zero-width characters (U+200B-200F). A package name or a config value
// carrying a right-to-left override can make its own tail render reversed
// in a terminal, the trojan-source trick a security tool's own report must
// not become a vector for. One definition, read by the text renderer (which
// strips these) and by config validation (which refuses a deny reason that
// carries any of them), so the two cannot disagree about the set.
export const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g'
);

// Text from the repository as one safe line: newlines collapse to a space
// first, so "a\nb" reads as "a b" rather than splitting into two lines, and
// every remaining character in CONTROL_CHARS is then removed.
export function sanitizeText(input: string): string {
  return input.replace(/\r\n|\r|\n/g, ' ').replace(CONTROL_CHARS, '');
}

// Whether a string carries any character in CONTROL_CHARS. A fresh pattern
// each call, since the shared one is global and test() on a global pattern
// keeps state between calls.
export function hasControlCharacter(input: string): boolean {
  return new RegExp(CONTROL_CHARS.source).test(input);
}
