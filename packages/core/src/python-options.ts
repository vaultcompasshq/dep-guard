// The options a requirements file may carry, read the way pip reads them.
//
// pip parses a requirements-file option line with optparse, through a
// parser holding exactly the options below (pip's req_file.py,
// SUPPORTED_OPTIONS plus SUPPORTED_OPTIONS_REQ). optparse accepts a long
// option as "--opt value", "--opt=value", and any UNIQUE prefix of a long
// option name ("--requirem=x.txt", "--extra-index https://..."); a prefix
// matching two names is an error, and so is an option it does not know. A
// short option takes its value from the rest of its own token ("-rx.txt")
// or from the next token ("-r x.txt", "-r\tx.txt"). The option text is
// split with shlex first, so a tab separates as a space does.
//
// Reading every one of those spellings matters because an option this
// reader did not recognise used to fall through to the name parser, match
// nothing, and vanish: "--requirement=more.txt" reached a file no pattern
// matched and no line was counted.

export interface RequirementsOption {
  name: string; // canonical long name, "--requirement"
  value: string | null;
}

interface OptionSpec {
  long: string;
  short?: string;
  takesValue: boolean;
  // The canonical name an alias resolves to (--pypi-url is --index-url).
  canonical?: string;
}

const OPTIONS: readonly OptionSpec[] = [
  { long: '--index-url', short: '-i', takesValue: true },
  { long: '--pypi-url', takesValue: true, canonical: '--index-url' },
  { long: '--extra-index-url', takesValue: true },
  { long: '--no-index', takesValue: false },
  { long: '--constraint', short: '-c', takesValue: true },
  { long: '--requirement', short: '-r', takesValue: true },
  { long: '--editable', short: '-e', takesValue: true },
  { long: '--find-links', short: '-f', takesValue: true },
  { long: '--no-binary', takesValue: true },
  { long: '--only-binary', takesValue: true },
  { long: '--prefer-binary', takesValue: false },
  { long: '--require-hashes', takesValue: false },
  { long: '--pre', takesValue: false },
  { long: '--trusted-host', takesValue: true },
  { long: '--use-feature', takesValue: true },
  { long: '--global-option', takesValue: true },
  { long: '--hash', takesValue: true },
  { long: '--config-settings', short: '-C', takesValue: true },
];

const BY_LONG = new Map(OPTIONS.map((spec) => [spec.long, spec]));
const BY_SHORT = new Map(
  OPTIONS.filter((spec) => spec.short !== undefined).map((spec) => [spec.short as string, spec])
);

function resolveLong(written: string): OptionSpec | null {
  const exact = BY_LONG.get(written);
  if (exact !== undefined) {
    return exact;
  }
  const matches = OPTIONS.filter((spec) => spec.long.startsWith(written));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * shlex.split in POSIX mode, for the subset a requirements option line
 * uses: whitespace separates, single and double quotes group, a backslash
 * escapes the next character outside single quotes. Null for an
 * unterminated quote, which pip rejects too.
 */
export function shlexSplit(text: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && index + 1 < text.length) {
        index += 1;
        current += text[index] ?? '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    inToken = true;
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '\\' && index + 1 < text.length) {
      index += 1;
      current += text[index] ?? '';
    } else {
      current += char;
    }
  }
  if (quote !== null) {
    return null;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parses the option part of a requirements line. Null when optparse would
 * reject the line: an unknown option, an ambiguous prefix, or a missing
 * value. Positional leftovers are ignored, as pip ignores them.
 */
export function parseRequirementsOptions(text: string): RequirementsOption[] | null {
  const tokens = shlexSplit(text);
  if (tokens === null) {
    return null;
  }
  const options: RequirementsOption[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      break;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const written = equals === -1 ? token : token.slice(0, equals);
      const spec = resolveLong(written);
      if (spec === null) {
        return null;
      }
      const name = spec.canonical ?? spec.long;
      if (!spec.takesValue) {
        if (equals !== -1) {
          return null;
        }
        options.push({ name, value: null });
        continue;
      }
      if (equals !== -1) {
        options.push({ name, value: token.slice(equals + 1) });
        continue;
      }
      const next = tokens[index + 1];
      if (next === undefined) {
        return null;
      }
      index += 1;
      options.push({ name, value: next });
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const spec = BY_SHORT.get(token.slice(0, 2));
      if (spec === undefined) {
        return null;
      }
      const name = spec.canonical ?? spec.long;
      const glued = token.slice(2);
      if (glued !== '') {
        options.push({ name, value: glued });
        continue;
      }
      const next = tokens[index + 1];
      if (next === undefined) {
        return null;
      }
      index += 1;
      options.push({ name, value: next });
      continue;
    }
    // A positional token: optparse returns it as a leftover argument and
    // pip ignores leftovers on an option line.
  }
  return options;
}
