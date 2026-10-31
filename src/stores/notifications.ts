import { create } from "zustand";

export type NoticeLevel = "info" | "success" | "warn" | "error";

export interface Notice {
  id: number;
  level: NoticeLevel;
  title: string;
  message?: string;
  at: number;
  read: boolean;
}

interface NotificationStore {
  /** Currently visible toasts. */
  toasts: Notice[];
  /** Session history shown in the notification centre (newest first). */
  history: Notice[];
  push: (level: NoticeLevel, title: string, message?: string) => void;
  dismiss: (id: number) => void;
  markAllRead: () => void;
  clearHistory: () => void;
}

let nextId = 1;
const TOAST_MS: Record<NoticeLevel, number> = { info: 3500, success: 3000, warn: 6000, error: 8000 };

export const useNotifications = create<NotificationStore>((set, get) => ({
  toasts: [],
  history: [],
  push: (level, title, message) => {
    const notice: Notice = { id: nextId++, level, title, message, at: Date.now(), read: false };
    set((s) => ({ toasts: [...s.toasts.slice(-3), notice], history: [notice, ...s.history].slice(0, 100) }));
    window.setTimeout(() => get().dismiss(notice.id), TOAST_MS[level]);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markAllRead: () => set((s) => ({ history: s.history.map((n) => ({ ...n, read: true })) })),
  clearHistory: () => set({ history: [] }),
}));

export const notify = {
  info: (title: string, message?: string) => useNotifications.getState().push("info", title, message),
  success: (title: string, message?: string) => useNotifications.getState().push("success", title, message),
  warn: (title: string, message?: string) => useNotifications.getState().push("warn", title, message),
  error: (title: string, message?: string) => useNotifications.getState().push("error", title, message),
};

/** Reports an unexpected failure from an async UI action. */
export function reportError(title: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  notify.error(title, message);
}
