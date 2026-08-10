// Comparing a dogfood run against a recorded one.
//
// The point of a baseline here is not to assert that dep-guard finds N
// things in vite. It is to make a change in what it finds on real
// repositories visible at the moment the change lands, rather than at the
// moment somebody notices months later that a rule went quiet. So the
// comparison is exact on counts and loud about anything that would make a
// comparison meaningless -- a repository that was not scanned, one that was
// not in the baseline, and above all a pin that moved.

export function flattenCounts(counts, prefix = '') {
  const flat = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    const keyPath = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === 'object') {
      Object.assign(flat, flattenCounts(value, keyPath));
    } else {
      flat[keyPath] = value;
    }
  }
  return flat;
}

function indexRepos(entries) {
  const byName = new Map();
  for (const entry of entries ?? []) {
    if (typeof entry?.repo === 'string') {
      byName.set(entry.repo, entry);
    }
  }
  return byName;
}

export function compareToBaseline(run, baseline) {
  if (baseline === null || typeof baseline !== 'object' || !Array.isArray(baseline.repos)) {
    throw new Error('baseline is missing or is not a recorded dogfood run');
  }

  const drift = [];
  const context = [];

  const before = indexRepos(baseline.repos);
  const after = indexRepos(run.repos);

  for (const [name, baseEntry] of before) {
    const runEntry = after.get(name);
    if (runEntry === undefined) {
      drift.push({ repo: name, kind: 'not-run' });
      continue;
    }
    // Checked before the counts, and reported instead of them: identical
    // counts at a different commit are not a reproduction, and different
    // counts at a different commit say nothing about this tool.
    if (baseEntry.sha !== runEntry.sha) {
      drift.push({ repo: name, kind: 'repinned', before: baseEntry.sha, after: runEntry.sha });
      continue;
    }
    const baseCounts = flattenCounts(baseEntry.counts);
    const runCounts = flattenCounts(runEntry.counts);
    for (const key of new Set([...Object.keys(baseCounts), ...Object.keys(runCounts)])) {
      const beforeValue = baseCounts[key] ?? 0;
      const afterValue = runCounts[key] ?? 0;
      if (beforeValue !== afterValue) {
        drift.push({ repo: name, kind: 'count', key, before: beforeValue, after: afterValue });
      }
    }
  }

  for (const name of after.keys()) {
    if (!before.has(name)) {
      drift.push({ repo: name, kind: 'unbaselined' });
    }
  }

  // A corpus refresh moves the existence check's answers on its own. That
  // is an explanation for a difference rather than a difference, so it is
  // said out loud and kept out of the drift list, which is reserved for
  // things a change to this tool could have caused.
  if (
    baseline.corpus?.builtAt !== undefined &&
    run.corpus?.builtAt !== undefined &&
    baseline.corpus.builtAt !== run.corpus.builtAt
  ) {
    context.push({
      kind: 'corpus-differs',
      before: baseline.corpus.builtAt,
      after: run.corpus.builtAt,
      beforeNameCount: baseline.corpus.nameCount ?? null,
      afterNameCount: run.corpus.nameCount ?? null,
    });
  }

  return { changed: drift.length > 0, drift, context };
}

export function formatComparison(comparison) {
  const lines = [];
  for (const note of comparison.context ?? []) {
    if (note.kind === 'corpus-differs') {
      lines.push(
        `note: the corpus differs from the baseline's (${note.before} with ` +
          `${note.beforeNameCount} names, now ${note.after} with ${note.afterNameCount}). ` +
          'Existence findings are expected to move with it.'
      );
    }
  }

  if (!comparison.changed) {
    lines.push('This run matches the baseline.');
    return lines.join('\n');
  }

  lines.push(`${comparison.drift.length} difference(s) from the baseline:`);
  for (const item of comparison.drift) {
    switch (item.kind) {
      case 'count':
        lines.push(`  ${item.repo}  ${item.key}: ${item.before} to ${item.after}`);
        break;
      case 'repinned':
        lines.push(
          `  ${item.repo}  pinned commit changed (${item.before} to ${item.after}); ` +
            'counts were not compared'
        );
        break;
      case 'not-run':
        lines.push(`  ${item.repo}  in the baseline but not in this run`);
        break;
      case 'unbaselined':
        lines.push(`  ${item.repo}  in this run but not in the baseline`);
        break;
      default:
        lines.push(`  ${item.repo}  ${item.kind}`);
    }
  }
  return lines.join('\n');
}
