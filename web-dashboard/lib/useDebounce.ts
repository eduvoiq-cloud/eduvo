/**
 * useDebounce — delays updating a value until the user stops typing.
 *
 * Usage:
 *   const debouncedSearch = useDebounce(search, 300);
 *   useEffect(() => { fetchResults(debouncedSearch); }, [debouncedSearch]);
 */
import { useState, useEffect } from 'react';

export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
