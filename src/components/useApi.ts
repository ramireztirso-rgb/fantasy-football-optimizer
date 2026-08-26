"use client";

import { useCallback, useEffect, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: { error: string; hint?: string } | null;
  loading: boolean;
  reload: () => void;
}

/** Minimal fetch hook. Supports POST bodies so the draft board can post state. */
export function useApi<T>(url: string, body?: unknown): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ error: string; hint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const serialized = body === undefined ? undefined : JSON.stringify(body);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    fetch(url, {
      signal: controller.signal,
      method: serialized === undefined ? "GET" : "POST",
      headers: serialized === undefined ? undefined : { "content-type": "application/json" },
      body: serialized,
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw json;
        setData(json as T);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const shaped = err as { error?: string; hint?: string };
        setError({ error: shaped?.error ?? "Request failed.", hint: shaped?.hint });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [url, serialized, nonce]);

  return { data, error, loading, reload };
}
