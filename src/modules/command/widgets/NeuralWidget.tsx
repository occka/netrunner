import { useMemo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, MessageSquarePlus } from "lucide-react";
import { ChatPanel } from "@/modules/neural/ChatPanel";
import { useNeural } from "@/modules/neural/store";
import { useNeuralSession } from "@/modules/neural/useNeuralSession";
import type { WidgetProps } from "./registry";

/** NEURAL chat as a dashboard widget or floating overlay. Shares the saved chats. */
export default function NeuralWidget({ editing }: WidgetProps) {
  useNeuralSession();
  const { status, chats, chatId, busy, openChat, newChat, attach } = useNeural();
  const options = useMemo(() => chats.slice(0, 30), [chats]);

  if (status && !status.configured) {
    return <div className="unavailable">Connect a Gemini API key in the NEURAL module first.</div>;
  }

  return (
    <div className="neural-widget" style={editing ? { pointerEvents: "none" } : undefined}>
      <div className="neural-widget__bar">
        <select className="select" value={chatId ?? ""} disabled={!!busy} onChange={(e) => void openChat(Number(e.target.value))}>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button className="icon-btn icon-btn--sm" title="New chat" disabled={!!busy} onClick={() => void newChat()}>
          <MessageSquarePlus size={13} />
        </button>
      </div>
      <ChatPanel
        compact
        attachControls={
          <button
            className="icon-btn icon-btn--sm"
            title="Attach a file"
            onClick={async () => {
              const picked = await openDialog({ multiple: false, title: "Attach file for NEURAL" });
              if (typeof picked === "string") attach({ kind: "file", path: picked });
            }}
          >
            <FileUp size={13} />
          </button>
        }
      />
    </div>
  );
}
