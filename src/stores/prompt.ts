import { create } from "zustand";

export interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Selects only the name part (before the extension) when the dialog opens. */
  selectStem?: boolean;
  /** Allows confirming an empty value (e.g. to clear a setting). */
  allowEmpty?: boolean;
}

interface PromptStore {
  request: (PromptRequest & { resolve: (value: string | null) => void }) | null;
  open: (req: PromptRequest) => Promise<string | null>;
  settle: (value: string | null) => void;
}

export const usePrompt = create<PromptStore>((set, get) => ({
  request: null,
  open: (req) =>
    new Promise((resolve) => {
      get().request?.resolve(null);
      set({ request: { ...req, resolve } });
    }),
  settle: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/** Promise-based single-line text prompt, rendered by <PromptHost/>. */
export const promptText = (req: PromptRequest) => usePrompt.getState().open(req);
