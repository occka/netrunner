import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNeural } from "./store";

/**
 * Loads NEURAL status and the active chat once per window, and reloads the
 * chat when another window (main ↔ overlay) saves new messages to it.
 */
export function useNeuralSession() {
  useEffect(() => {
    const s = useNeural.getState();
    if (!s.status) void s.loadStatus().catch(() => undefined);
    if (s.chatId == null) void s.openChat().catch(() => undefined);
    const un = listen<number | null>("neural://changed", (e) => {
      const st = useNeural.getState();
      if (st.busy) return;
      if (e.payload == null || e.payload === st.chatId) void st.openChat(st.chatId ?? undefined).catch(() => undefined);
    });
    return () => void un.then((off) => off());
  }, []);
}
