// Python project names, in the one form every comparison uses.
//
// PEP 503: a project name is compared lower-cased, with every run of "-",
// "_" and "." collapsed to a single "-". "Django_REST.framework" and
// "django-rest-framework" are one project on PyPI, and pip installs the
// same thing for either spelling. The normalised form is computed once, in
// the parser, and stored as the dependency's registryName; the written
// form is kept for display only (docs/INVARIANTS.md).
//
// Both functions are loops, not regular expressions: a name comes out of
// a file the change under review wrote, and typosquat.ts already treats
// every such name as attacker-controlled input.

function isAsciiAlphanumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  );
}

function isSeparator(code: number): boolean {
  return code === 0x2d || code === 0x5f || code === 0x2e; // - _ .
}

/**
 * True when `name` is a valid PEP 508 project name: ASCII letters and
 * digits, with ".", "_" and "-" allowed only between them. Every name
 * source (a requirement string, a TOML table key, a lockfile entry) goes
 * through this before the name is stored, so normalizePypiName below only
 * ever sees ASCII.
 */
export function isValidPythonName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (isAsciiAlphanumeric(code)) {
      continue;
    }
    if (!isSeparator(code) || index === 0 || index === name.length - 1) {
      return false;
    }
  }
  return true;
}

/** The PEP 503 normalised form of a project name. */
export function normalizePypiName(name: string): string {
  let normalised = '';
  let inSeparatorRun = false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (isSeparator(code)) {
      if (!inSeparatorRun) {
        normalised += '-';
        inSeparatorRun = true;
      }
      continue;
    }
    inSeparatorRun = false;
    // ASCII lower-casing only: the name pattern above admits nothing else.
    normalised += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : name[index];
  }
  return normalised;
}

/**
 * The name as a reader should see it: as written, with the PyPI project it
 * resolves to added once when the two differ.
 */
export function pypiDisplayName(written: string, normalised: string): string {
  return written === normalised ? `"${written}"` : `"${written}" (PyPI project "${normalised}")`;
}

const MAX_FRAGMENT_LENGTH = 100;

/**
 * What may be printed of a string that failed the name pattern: its
 * leading run of name characters, capped, with "..." when anything was cut.
 * Never the rest. An invalid requirement string can carry a URL with a
 * token in its userinfo ("_x @ git+https://user:TOKEN@host/r.git"), and the
 * text before an "@" is no safer ("user:TOKEN@host"), so only characters
 * the name pattern itself admits are echoed into a diagnostic.
 */
export function invalidNameFragment(text: string): string {
  let end = 0;
  while (end < text.length && end < MAX_FRAGMENT_LENGTH) {
    const code = text.charCodeAt(end);
    const nameChar =
      (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || isSeparator(code);
    if (!nameChar) {
      break;
    }
    end += 1;
  }
  if (end === 0) {
    return '(no name characters)';
  }
  return end === text.length ? text : `${text.slice(0, end)}...`;
}

/**
 * The same rule for a path a requirements file names (an unread -r
 * target): name characters and path separators, capped, "..." when cut.
 * A ":" or "@" ends it, so userinfo written into the target never prints.
 */
export function pathFragment(text: string): string {
  let end = 0;
  while (end < text.length && end < MAX_FRAGMENT_LENGTH) {
    const code = text.charCodeAt(end);
    const pathChar =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      isSeparator(code) ||
      code === 0x2f || // /
      code === 0x5c; // \
    if (!pathChar) {
      break;
    }
    end += 1;
  }
  if (end === 0) {
    return '(no path characters)';
  }
  return end === text.length ? text : `${text.slice(0, end)}...`;
}
