import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data once and optionally refreshes it on an interval while the window
 * is visible. `intervalMs = 0` disables polling (manual `reload` only).
 */
export function usePolled<T>(load: () => Promise<T>, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const id = window.setInterval(() => !document.hidden && void reload(), intervalMs);
    return () => window.clearInterval(id);
  }, [reload, intervalMs]);

  return { data, error, loading, reload, setData };
}
