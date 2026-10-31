import { Channel } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
import type { Attachment, ContextItem, ModelInfo, NeuralStatus, StreamEvent } from "@/types/neural";

export interface ChatMessage {
  id: number;
  role: "user" | "model";
  text: string;
  /** Labels of the context items that were actually sent with this message. */
  sent?: string[];
  model?: string;
  fallback?: boolean;
  streaming?: boolean;
  /** Progress text while waiting for the first token (e.g. trying another model). */
  status?: string;
  error?: string;
  tokens?: { prompt: number | null; output: number | null };
}

interface NeuralStore {
  status: NeuralStatus | null;
  models: ModelInfo[];
  messages: ChatMessage[];
  /** Attachments for the next message only (explicitly chosen by the user). */
  pending: Attachment[];
  preview: ContextItem[];
  draft: string;
  busy: number | null;
  /** Persisted chats (local SQLite); chatId is the open one. */
  chatId: number | null;
  chats: ChatSummary[];
  openChat: (id?: number) => Promise<void>;
  newChat: () => Promise<void>;
  deleteChat: (id: number) => Promise<void>;
  loadStatus: () => Promise<void>;
  loadModels: () => Promise<void>;
  connect: (key: string) => Promise<void>;
  disconnect: () => Promise<void>;
  attach: (a: Attachment) => void;
  detach: (index: number) => void;
  setDraft: (text: string) => void;
  send: () => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

export interface ChatSummary {
  id: number;
  title: string;
  updatedAt: string;
  messageCount: number;
}

let nextId = 1;
let nextRequest = Date.now();

function sameAttachment(a: Attachment, b: Attachment) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path.toLowerCase() === b.path.toLowerCase();
  if (a.kind === "tree" && b.kind === "tree") return a.root === b.root;
  return false;
}

export const useNeural = create<NeuralStore>((set, get) => {
  const refreshPreview = async () => {
    const pending = get().pending;
    set({ preview: pending.length ? await api.neural.preview(pending).catch(() => []) : [] });
  };

  return {
    status: null,
    models: [],
    messages: [],
    pending: [],
    preview: [],
    draft: "",
    busy: null,
    chatId: null,
    chats: [],

    openChat: async (id) => {
      if (get().busy) return;
      const st = await api.neural.chatOpen(id);
      set({
        chatId: st.activeId,
        chats: st.chats,
        messages: st.messages.map((m) => ({ id: nextId++, role: m.role, text: m.text, model: m.model ?? undefined, sent: m.sent })),
      });
    },
    newChat: async () => {
      if (get().busy) return;
      const st = await api.neural.chatNew();
      set({ chatId: st.activeId, chats: st.chats, messages: [], draft: "", pending: [], preview: [] });
    },
    deleteChat: async (id) => {
      await api.neural.chatDelete(id);
      if (get().chatId === id) await get().openChat();
      else set({ chats: (await api.neural.chatOpen(get().chatId ?? undefined)).chats });
      void emit("neural://changed", null);
    },

    loadStatus: async () => set({ status: await api.neural.status() }),
    loadModels: async () => set({ models: await api.neural.models() }),

    connect: async (key) => {
      const models = await api.neural.connect(key);
      set({ models, status: await api.neural.status() });
      refreshActivity();
    },

    disconnect: async () => {
      await api.neural.disconnect();
      set({ status: await api.neural.status(), models: [] });
      refreshActivity();
    },

    attach: (a) => {
      if (get().pending.some((p) => sameAttachment(p, a))) return;
      set((s) => ({ pending: [...s.pending, a] }));
      void refreshPreview();
    },
    detach: (index) => {
      set((s) => ({ pending: s.pending.filter((_, i) => i !== index) }));
      void refreshPreview();
    },
    setDraft: (draft) => set({ draft }),

    send: async () => {
      const { draft, pending, messages, busy } = get();
      const text = draft.trim();
      if (!text || busy) return;
      const preview = pending.length ? await api.neural.preview(pending).catch(() => []) : [];
      const user: ChatMessage = { id: nextId++, role: "user", text, sent: preview.filter((p) => !p.error).map((p) => p.label) };
      const reply: ChatMessage = { id: nextId++, role: "model", text: "", streaming: true };
      const requestId = nextRequest++;
      // History excludes failed replies so a retry does not re-send error text.
      const history = [...messages, user]
        .filter((m) => !m.error && m.text)
        .map((m) => ({ role: m.role, text: m.text }));
      set({ messages: [...messages, user, reply], draft: "", pending: [], preview: [], busy: requestId });
      const chatId = get().chatId ?? (await api.neural.chatNew()).activeId;
      if (get().chatId !== chatId) set({ chatId });
      await api.neural.chatAppend(chatId, { role: "user", text, model: null, sent: user.sent ?? [] }).catch(() => undefined);

      const update = (patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === reply.id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
        }));

      const channel = new Channel<StreamEvent>();
      channel.onmessage = (e) => {
        if (e.type === "status") update({ status: e.text });
        else if (e.type === "model") update({ model: e.model, fallback: e.fallback, status: undefined });
        else if (e.type === "delta") update((m) => ({ text: m.text + e.text }));
        else
          update({
            streaming: false,
            status: undefined,
            tokens: { prompt: e.promptTokens, output: e.outputTokens },
            error: e.finishReason === "CANCELLED" ? "Stopped" : e.finishReason && !["STOP", "MAX_TOKENS"].includes(e.finishReason) ? `Finished: ${e.finishReason}` : undefined,
          });
      };
      try {
        await api.neural.chat(history, pending, requestId, channel);
      } catch (err) {
        update({ streaming: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        update({ streaming: false, status: undefined });
        set({ busy: null });
        refreshActivity();
        const done = get().messages.find((m) => m.id === reply.id);
        if (done?.text && !done.error) {
          await api.neural.chatAppend(chatId, { role: "model", text: done.text, model: done.model ?? null, sent: [] }).catch(() => undefined);
        }
        const st = await api.neural.chatOpen(chatId).catch(() => null);
        if (st) set({ chats: st.chats });
        // Other windows (main / overlay) showing this chat reload it.
        void emit("neural://changed", chatId);
      }
    },

    cancel: () => {
      const id = get().busy;
      if (id) void api.neural.cancel(id);
    },
    clear: () => void get().newChat(),
  };
});

/** Pre-fills the composer (e.g. from FILES "Analyze with AI"); never sends by itself. */
export function prefillNeural(text: string, attachments: Attachment[] = []) {
  const s = useNeural.getState();
  s.setDraft(text);
  attachments.forEach((a) => s.attach(a));
}

/** Extracts fenced code blocks from a reply. */
export function codeBlocks(text: string): { lang: string; code: string }[] {
  const out: { lang: string; code: string }[] = [];
  const re = /```([\w.+-]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ lang: m[1], code: m[2].replace(/\n$/, "") });
  return out;
}
