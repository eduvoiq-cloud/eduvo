/**
 * Normalises a term value to the canonical underscore format used throughout
 * the app: "term_1", "term_2", "term_3".
 *
 * Handles the legacy title-case format stored by the old POST /api/tests route
 * ("Term 1", "Term 2", "Term 3") as well as free-text entries like "term1",
 * "TERM_1", "Term1", etc.
 *
 * Unknown values are returned unchanged so we don't silently discard data.
 */
export function normaliseTerm(term: string | undefined | null): string | undefined {
  if (!term) return undefined;
  // Strip whitespace, lower-case, then collapse spaces/underscores/dashes
  const cleaned = term.trim().toLowerCase().replace(/[\s\-_]+/g, '_');
  // Match term_1 / term1 variants
  const match = cleaned.match(/^term_?(\d)$/);
  if (match) return `term_${match[1]}`;
  return term; // return original if we can't normalise
}

/**
 * Given a filter term value from a query string (which may be in any format),
 * returns an array of all equivalent stored values to match against.
 * e.g. "term_1" → ["term_1", "Term 1", "term1"]
 */
export function termFilterValues(term: string): string[] {
  const normalised = normaliseTerm(term);
  if (!normalised || !normalised.startsWith('term_')) return [term];
  const n = normalised.slice(5); // digit(s)
  return [
    `term_${n}`,
    `Term ${n}`,
    `term${n}`,
    `TERM_${n}`,
    `Term_${n}`,
  ];
}
