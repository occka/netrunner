import { Channel } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";
import { api } from "@/services/api";
import { refreshActivity } from "@/stores/activity";
import type { Attachment, ContextItem, ModelInfo, NeuralAction, NeuralMode, NeuralStatus, StreamEvent } from "@/types/neural";
import { encodePhoto } from "./images";

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
  /** Photos sent with this message (names in the chat's folder). */
  images?: string[];
  /** What the agent did while answering. */
  actions?: NeuralAction[];
  /** How many older messages were left out of this request. */
  dropped?: number;
}

interface NeuralStore {
  status: NeuralStatus | null;
  models: ModelInfo[];
  messages: ChatMessage[];
  /** Attachments for the next message only (explicitly chosen by the user). */
  pending: Attachment[];
  /** Attachments that go with every message of this chat. */
  kept: Attachment[];
  preview: ContextItem[];
  mode: NeuralMode;
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
  /** `agent`: the NEURAL tab, with the chat's mode and folder. Off in DEVELOPER's panel. */
  send: (agent?: boolean) => Promise<void>;
  setMode: (mode: NeuralMode) => Promise<void>;
  keep: (index: number) => Promise<void>;
  unkeep: (index: number) => Promise<void>;
  /** Re-encodes a photo (dropping its metadata), stores it and attaches it. */
  attachPhoto: (blob: Blob) => Promise<void>;
  undo: (messageId: number, change: number) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

export interface ChatSummary {
  id: number;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/** Tells other windows showing this chat (main / overlay) to reload it. */
export interface NeuralChanged {
  chatId: number | null;
  source: string;
}
export const neuralWindow = () => getCurrentWindow().label;
const announce = (chatId: number | null) => emit("neural://changed", { chatId, source: neuralWindow() } satisfies NeuralChanged);

let nextId = 1;
let nextRequest = Date.now();

function sameAttachment(a: Attachment, b: Attachment) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path.toLowerCase() === b.path.toLowerCase();
  if (a.kind === "tree" && b.kind === "tree") return a.root === b.root;
  if (a.kind === "image" && b.kind === "image") return a.name === b.name;
  return false;
}

export const useNeural = create<NeuralStore>((set, get) => {
  const refreshPreview = async () => {
    const all = [...get().pending, ...get().kept];
    set({ preview: all.length ? await api.neural.preview(all).catch(() => []) : [] });
  };

  return {
    status: null,
    models: [],
    messages: [],
    pending: [],
    kept: [],
    preview: [],
    mode: "work",
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
        mode: st.mode,
        kept: st.kept,
        // A photo belongs to the folder of the chat it was added in.
        pending: st.activeId === get().chatId ? get().pending : get().pending.filter((a) => a.kind !== "image"),
        messages: st.messages.map((m) => ({ id: nextId++, role: m.role, text: m.text, model: m.model ?? undefined, sent: m.sent, images: m.images, actions: m.actions })),
      });
      void refreshPreview();
    },
    newChat: async () => {
      if (get().busy) return;
      const st = await api.neural.chatNew();
      set({ chatId: st.activeId, chats: st.chats, messages: [], draft: "", pending: [], kept: [], preview: [], mode: st.mode });
    },
    deleteChat: async (id) => {
      await api.neural.chatDelete(id);
      if (get().chatId === id) await get().openChat();
      else set({ chats: (await api.neural.chatOpen(get().chatId ?? undefined)).chats });
      void announce(null);
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

    setMode: async (mode) => {
      const chatId = get().chatId;
      if (chatId == null || get().busy) return;
      await api.neural.chatSetMode(chatId, mode);
      set({ mode });
    },

    keep: async (index) => {
      const { pending, kept, chatId } = get();
      const item = pending[index];
      if (!item || chatId == null) return;
      const next = kept.some((k) => sameAttachment(k, item)) ? kept : [...kept, item];
      await api.neural.chatSetKept(chatId, next);
      set({ kept: next, pending: pending.filter((_, i) => i !== index) });
      void refreshPreview();
    },
    unkeep: async (index) => {
      const { kept, chatId } = get();
      if (chatId == null) return;
      const next = kept.filter((_, i) => i !== index);
      await api.neural.chatSetKept(chatId, next);
      set({ kept: next });
      void refreshPreview();
    },

    attachPhoto: async (blob) => {
      const { data, bytes } = await encodePhoto(blob);
      const chatId = get().chatId ?? (await api.neural.chatNew()).activeId;
      if (get().chatId !== chatId) set({ chatId });
      const name = await api.neural.imageSave(chatId, data);
      get().attach({ kind: "image", name, bytes });
    },

    undo: async (messageId, change) => {
      const chatId = get().chatId;
      if (chatId == null) return;
      await api.neural.undo(chatId, change);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, actions: m.actions?.map((a) => (a.change === change ? { ...a, change: null, error: "Undone" } : a)) } : m,
        ),
      }));
    },

    send: async (agent = true) => {
      const { draft, pending, kept, messages, busy } = get();
      const images = pending.flatMap((a) => (a.kind === "image" ? [a.name] : []));
      const text = draft.trim() || (images.length ? "[photo]" : "");
      if (!text || busy) return;
      const attachments = [...pending.filter((a) => a.kind !== "image"), ...kept];
      const preview = attachments.length ? await api.neural.preview(attachments).catch(() => []) : [];
      const user: ChatMessage = { id: nextId++, role: "user", text, images, sent: preview.filter((p) => !p.error && p.label !== "Photo").map((p) => p.label) };
      const reply: ChatMessage = { id: nextId++, role: "model", text: "", streaming: true };
      const requestId = nextRequest++;
      // History excludes failed replies so a retry does not re-send error text.
      const history = [...messages, user]
        .filter((m) => !m.error && (m.text || m.actions?.length))
        .map((m) => ({ role: m.role, text: withActions(m), images: m.images ?? [] }));
      set({ messages: [...messages, user, reply], draft: "", pending: [], busy: requestId });
      void refreshPreview();
      const chatId = get().chatId ?? (await api.neural.chatNew()).activeId;
      if (get().chatId !== chatId) set({ chatId });
      await api.neural.chatAppend(chatId, { role: "user", text, model: null, sent: user.sent ?? [], images }).catch(() => undefined);

      const update = (patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === reply.id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
        }));

      const channel = new Channel<StreamEvent>();
      channel.onmessage = (e) => {
        if (e.type === "status") update({ status: e.text });
        else if (e.type === "model") update({ model: e.model, fallback: e.fallback, status: undefined });
        else if (e.type === "delta") update((m) => ({ text: m.text + e.text }));
        else if (e.type === "action") update((m) => ({ actions: [...(m.actions ?? []), e.action] }));
        else if (e.type === "context") update({ dropped: e.dropped });
        else
          update({
            streaming: false,
            status: undefined,
            tokens: { prompt: e.promptTokens, output: e.outputTokens },
            error: e.finishReason === "CANCELLED" ? "Stopped" : e.finishReason && !["STOP", "MAX_TOKENS"].includes(e.finishReason) ? `Finished: ${e.finishReason}` : undefined,
          });
      };
      try {
        await api.neural.chat(chatId, agent, history, attachments, requestId, channel);
      } catch (err) {
        update({ streaming: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        update({ streaming: false, status: undefined });
        set({ busy: null });
        refreshActivity();
        const done = get().messages.find((m) => m.id === reply.id);
        // Files may have changed even if the reply then failed, so actions are kept too.
        if (done && (done.text || done.actions?.length) && (!done.error || done.actions?.length)) {
          await api.neural.chatAppend(chatId, { role: "model", text: done.text, model: done.model ?? null, sent: [], actions: done.actions ?? [] }).catch(() => undefined);
        }
        const st = await api.neural.chatOpen(chatId).catch(() => null);
        if (st) set({ chats: st.chats });
        void announce(chatId);
      }
    },

    cancel: () => {
      const id = get().busy;
      if (id) void api.neural.cancel(id);
    },
    clear: () => void get().newChat(),
  };
});

/**
 * The model's next requests carry only text, so its own actions are written into
 * the reply: otherwise it would forget a dice result it did not repeat.
 */
function withActions(m: ChatMessage) {
  const done = (m.actions ?? []).filter((a) => a.kind !== "python" && a.error !== "Undone");
  if (!done.length) return m.text;
  const list = done.map((a) => (a.kind === "dice" ? `rolled ${a.label}` : `${a.kind} ${a.label}${a.error ? " (failed)" : ""}`)).join("; ");
  return `${m.text}\n[Tool actions: ${list}]`.trim();
}

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
