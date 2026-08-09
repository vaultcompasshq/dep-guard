// Banded Levenshtein distance, used by the typosquat check to compare a
// new dependency name against the popularity list.
//
// Two properties matter here beyond correctness. Package names are
// attacker-controlled strings, so the implementation is loop-based with no
// regular expressions anywhere on the path (this codebase has had two
// ReDoS findings already), and the work is bounded: only cells within
// maxK of the diagonal are computed, so cost is O(length * maxK) rather
// than O(length^2), with an early return as soon as a whole row is beyond
// the band. Two rolling rows keep memory linear.
//
// Comparison is by UTF-16 code unit. npm package names are lowercase and
// effectively ASCII, so this matches how the rest of the pipeline treats
// them; a name outside that range simply compares unit by unit.

/**
 * Edit distance between `a` and `b`, or null when the distance exceeds
 * `maxK`. Never returns a number greater than `maxK`.
 */
export function bandedDistance(a: string, b: string, maxK: 1 | 2): number | null {
  const aLength = a.length;
  const bLength = b.length;

  // Every edit changes the length by at most one, so a wider length gap
  // than the band cannot be closed.
  if (aLength - bLength > maxK || bLength - aLength > maxK) {
    return null;
  }
  if (a === b) {
    return 0;
  }

  // One past the band. Cells outside the band hold this value, and it is
  // also the clamp that keeps arithmetic from drifting upward.
  const beyond = maxK + 1;
  const width = bLength + 1;

  let previous = new Int32Array(width).fill(beyond);
  let current = new Int32Array(width).fill(beyond);

  // Row 0 is the cost of deleting a prefix of b, which is the prefix
  // length, and only stays inside the band for the first maxK columns.
  const firstRowEnd = bLength < maxK ? bLength : maxK;
  for (let column = 0; column <= firstRowEnd; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= aLength; row += 1) {
    const low = row - maxK < 1 ? 1 : row - maxK;
    const high = row + maxK > bLength ? bLength : row + maxK;

    // Only the band is written, so the two cells just outside it are reset
    // instead of clearing the whole row -- clearing the row would make the
    // whole computation quadratic again, which is the entire point of the
    // band. The cell left of the band is read by this row's first column,
    // and the cell right of the band is read by the next row's last one.
    let rowBest = beyond;
    if (row <= maxK) {
      // Column 0 is the cost of deleting a prefix of a, and is still
      // inside the band for the first maxK rows.
      current[0] = row;
      rowBest = row;
    } else {
      current[low - 1] = beyond;
    }
    if (high < bLength) {
      current[high + 1] = beyond;
    }

    const aUnit = a.charCodeAt(row - 1);

    for (let column = low; column <= high; column += 1) {
      const substitution = previous[column - 1] + (aUnit === b.charCodeAt(column - 1) ? 0 : 1);
      const deletion = previous[column] + 1;
      const insertion = current[column - 1] + 1;

      let best = substitution;
      if (deletion < best) {
        best = deletion;
      }
      if (insertion < best) {
        best = insertion;
      }
      if (best > beyond) {
        best = beyond;
      }

      current[column] = best;
      if (best < rowBest) {
        rowBest = best;
      }
    }

    // Distances never decrease as rows are consumed, so once an entire row
    // sits outside the band the final cell will too.
    if (rowBest > maxK) {
      return null;
    }

    const spent = previous;
    previous = current;
    current = spent;
  }

  const distance = previous[bLength];
  return distance > maxK ? null : distance;
}
