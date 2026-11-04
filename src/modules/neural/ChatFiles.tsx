import { useEffect, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { api } from "@/services/api";
import { formatBytes } from "@/utils/format";
import { useNeural } from "./store";

/** The files the agent keeps for this chat. The user can read them here or edit them in Explorer. */
export function ChatFiles({ chatId, onOpen, icon }: { chatId: number; onOpen: () => void; icon: ReactNode }) {
  const busy = useNeural((s) => s.busy);
  // Changes when the agent does something or a change is undone, not on every word of a reply.
  const actions = useNeural((s) => s.messages.map((m) => m.actions?.map((a) => a.change ?? a.error).join() ?? "").join("|"));
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]);
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void api.neural.files(chatId).then((list) => live && setFiles(list), () => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [chatId, busy, actions]);

  useEffect(() => setOpen(null), [chatId]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void api.neural.fileRead(chatId, open.path).then(
      (text) => live && setOpen((o) => (o && o.path === open.path && o.text !== text ? { path: o.path, text } : o)),
      () => live && setOpen(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, busy, actions, open?.path]);

  return (
    <aside className="chat-files">
      <div className="chat-files__head">
        <span className="label">This chat's folder</span>
        <button className="btn btn--ghost btn--sm" onClick={onOpen} title="Open the folder in Explorer">
          {icon} Open
        </button>
      </div>
      {files.length === 0 ? (
        <p className="muted chat-files__note">Empty. NEURAL creates files here when it needs them. It cannot reach anything else on your PC.</p>
      ) : (
        <div className="chat-files__list">
          {files.map((f) => (
            <button key={f.path} className="chat-files__item" aria-pressed={open?.path === f.path} title={f.path} onClick={() => setOpen(open?.path === f.path ? null : { path: f.path, text: "" })}>
              <FileText size={12} />
              <span className="truncate">{f.path}</span>
              <span className="muted mono">{formatBytes(f.size)}</span>
            </button>
          ))}
        </div>
      )}
      {open && <pre className="chat-files__text" data-selectable>{open.text}</pre>}
      <p className="muted chat-files__note">Files in the top level go with every message. Others are read when needed.</p>
    </aside>
  );
}
