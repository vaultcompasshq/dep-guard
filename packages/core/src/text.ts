// A JSON or YAML file the scan reads may start with a UTF-8 byte order
// mark; npm and pnpm read such a file, so every parser here removes it
// first. One helper, so no parse site is left out.
export function withoutByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
