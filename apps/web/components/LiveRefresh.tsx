"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * Подписка на изменения таблиц через Supabase Realtime: при событии обновляет
 * серверные компоненты страницы (router.refresh) с небольшим дебаунсом.
 */
export function LiveRefresh({ tables, filter }: { tables: string[]; filter?: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = tables.join(",");

  useEffect(() => {
    const sb = supabaseBrowser();
    const channel = sb.channel(`live:${key}:${filter ?? "all"}`);
    for (const table of key.split(",")) {
      channel.on("postgres_changes", { event: "*", schema: "public", table, ...(filter ? { filter } : {}) }, () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 400);
      });
    }
    channel.subscribe();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void sb.removeChannel(channel);
    };
  }, [router, key, filter]);

  return null;
}
