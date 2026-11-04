import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { neuralWindow, useNeural, type NeuralChanged } from "./store";

/**
 * Loads NEURAL status and the active chat once per window, and reloads the
 * chat when another window (main ↔ overlay) saves new messages to it.
 */
export function useNeuralSession() {
  useEffect(() => {
    const s = useNeural.getState();
    if (!s.status) void s.loadStatus().catch(() => undefined);
    if (s.chatId == null) void s.openChat().catch(() => undefined);
    const un = listen<NeuralChanged>("neural://changed", (e) => {
      const st = useNeural.getState();
      // This window already shows its own reply, with errors and token counts a reload would lose.
      if (st.busy || e.payload.source === neuralWindow()) return;
      if (e.payload.chatId == null || e.payload.chatId === st.chatId) void st.openChat(st.chatId ?? undefined).catch(() => undefined);
    });
    return () => void un.then((off) => off());
  }, []);
}
