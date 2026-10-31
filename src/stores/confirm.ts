import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmStore {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  open: (req: ConfirmRequest) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

export const useConfirm = create<ConfirmStore>((set, get) => ({
  request: null,
  open: (req) =>
    new Promise<boolean>((resolve) => {
      get().request?.resolve(false);
      set({ request: { ...req, resolve } });
    }),
  settle: (ok) => {
    get().request?.resolve(ok);
    set({ request: null });
  },
}));

/** Promise-based confirmation dialog, rendered by <ConfirmHost/>. */
export const confirmAction = (req: ConfirmRequest) => useConfirm.getState().open(req);
