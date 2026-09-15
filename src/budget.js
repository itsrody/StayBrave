// Budget pass for the lite profile: cap the number of network rules the output
// carries so uBO Lite's runtime compilation into dynamic DNR rules stays under
// the Chromium guarantee of 30 000 (default budget 25 000, see config.lite).
//
// Semantics:
//   * cosmetic lines (`##`/`#@#`) never count — uBO Lite ships them as CSS
//     content scripts, not DNR rules;
//   * network exceptions (`@@`, `#@#` cosmetics) are never pruned — dropping
//     an exception would *broaden* blocking, which the pipeline forbids;
//   * blocking network rules are pruned by source priority (lists.json
//     `priority`, default 3); higher priority survives first. Within one
//     priority band, domain-anchored blocking rules survive before bare
//     request-substring patterns, so limited slots buy full-host coverage.
//     This is an intentional, reported coverage reduction — it runs *after* the
//     engine-certified subsumption gates and the coverage recheck, so those
//     gates keep proving the subsumption removals while the budget pass only
//     removes rules wholesale.
//
// Returns the trimmed rules plus accounting to report budget usage.

export function isCosmeticLine(line) {
  return line.includes('##') || line.includes('#@#');
}

export function isExceptionLine(line) {
  return line.startsWith('@@') || line.includes('#@#');
}

// Retention rank for a blocking network rule within one priority band. A
// domain-anchored `||host^` blocks the whole host and its subdomains — the
// tightest coverage per DNR slot — so it should survive the budget before a
// bare request-substring pattern (`&foo=`, `%2F…`) that only catches one URL.
export function blockingRank(line) {
  if (line.startsWith('||')) return 2;
  if (line.startsWith('|') || line.startsWith('/')) return 1;
  return 0;
}

export function trimToBudget(rules, { budget = 25000, priorityOf = () => 3 } = {}) {
  const items = rules.map((line) => ({
    line,
    cosmetic: isCosmeticLine(line),
    exception: isExceptionLine(line),
  }));

  const networkTotal = items.filter((i) => !i.cosmetic).length;
  const exceptions = items.filter((i) => !i.cosmetic && i.exception).length;
  const blocking = networkTotal - exceptions;

  // Headroom left for blocking rules after reserving every exception.
  const allowance = Math.max(0, budget - exceptions);

  // Nothing to trim.
  if (networkTotal <= budget) {
    return {
      rules,
      dropped: 0,
      exceptions,
      network: networkTotal,
      blocking,
      budget,
      dropped_by_priority: {},
    };
  }

  const protect = [];
  const cands = [];
  for (const i of items) {
    if (i.cosmetic || i.exception) protect.push(i);
    else cands.push(i);
  }

  // Deterministic: priority desc, then within a priority band prefer
  // domain-anchored blocking rules (blockingRank), then lexical ascending
  // (order-preserving — rules were globally sorted upstream).
  cands.sort(
    (a, b) =>
      priorityOf(b.line) - priorityOf(a.line) ||
      blockingRank(b.line) - blockingRank(a.line) ||
      (a.line < b.line ? -1 : a.line > b.line ? 1 : 0)
  );

  const keptBlocking = cands.slice(0, allowance);
  const droppedList = cands.slice(allowance);

  const droppedByPriority = {};
  for (const i of droppedList) {
    const p = priorityOf(i.line);
    droppedByPriority[p] = (droppedByPriority[p] ?? 0) + 1;
  }

  const finalLines = [...protect, ...keptBlocking]
    .map((i) => i.line)
    .sort();

  return {
    rules: finalLines,
    dropped: droppedList.length,
    exceptions,
    network: finalLines.filter((l) => !isCosmeticLine(l)).length,
    blocking: networkTotal - exceptions - droppedList.length,
    budget,
    dropped_by_priority: droppedByPriority,
  };
}