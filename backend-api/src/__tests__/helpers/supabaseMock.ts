export interface QueryResult {
  data: unknown;
  error: unknown | null;
}

/**
 * Builds a chainable mock that mirrors Supabase's PostgREST query builder.
 * Terminal methods (single, maybeSingle) resolve to `result`.
 */
export function buildQueryChain(result: QueryResult) {
  const chain: Record<string, jest.Mock> = {};
  const self = (): Record<string, jest.Mock> => chain;

  const passthroughMethods = [
    'select',
    'eq',
    'neq',
    'or',
    'ilike',
    'update',
    'insert',
    'filter',
    'order',
    'limit',
  ];

  for (const method of passthroughMethods) {
    chain[method] = jest.fn().mockImplementation(self);
  }

  chain.single = jest.fn().mockResolvedValue(result);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);

  return chain;
}
