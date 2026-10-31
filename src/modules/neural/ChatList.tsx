import { MessageSquarePlus, Trash2 } from "lucide-react";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import { formatRelative, parseDbTime } from "@/utils/format";
import { useNeural } from "./store";

/** Saved conversations (local only). */
export function ChatList() {
  const { chats, chatId, busy, openChat, newChat, deleteChat } = useNeural();

  return (
    <aside className="chat-list">
      <button className="btn btn--primary btn--sm chat-list__new" onClick={() => void newChat().catch((e) => reportError("Could not create chat", e))} disabled={!!busy}>
        <MessageSquarePlus size={13} /> New chat
      </button>
      <div className="chat-list__items">
        {chats.map((c) => (
          <div
            key={c.id}
            className="chat-list__item"
            aria-selected={c.id === chatId}
            onClick={() => c.id !== chatId && !busy && void openChat(c.id)}
            title={c.title}
          >
            <div className="truncate">{c.title}</div>
            <div className="muted chat-list__meta">
              {c.messageCount} msg · {formatRelative(parseDbTime(c.updatedAt))}
            </div>
            <button
              className="icon-btn icon-btn--sm chat-list__del"
              title="Delete chat"
              onClick={async (e) => {
                e.stopPropagation();
                if (await confirmAction({ title: "Delete chat", message: `Delete “${c.title}” and its messages?`, confirmLabel: "Delete", danger: true }))
                  await deleteChat(c.id).catch((err) => reportError("Could not delete chat", err));
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <p className="muted chat-list__note">Chats are stored only on this PC (local database).</p>
    </aside>
  );
}
