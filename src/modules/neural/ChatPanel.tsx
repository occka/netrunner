import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, BrainCircuit, Copy, FileDiff, Paperclip, Send, Square, Trash2, X } from "lucide-react";
import { notify } from "@/stores/notifications";
import { formatBytes } from "@/utils/format";
import { useNeural, type ChatMessage } from "./store";

interface ChatPanelProps {
  compact?: boolean;
  /** Extra attach buttons (file picker, active file, selection…). */
  attachControls?: ReactNode;
  /** When set, code blocks offer "Review as diff" against this file. */
  reviewTarget?: { path: string; onReview: (code: string) => void };
}

/** Renders text with fenced code blocks and inline `code`; no HTML is interpreted. */
function MessageText({ text, reviewTarget }: { text: string; reviewTarget?: ChatPanelProps["reviewTarget"] }) {
  const parts = text.split(/(```[\w.+-]*[^\n]*\n[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        const block = /^```([\w.+-]*)[^\n]*\n([\s\S]*?)```$/.exec(part);
        if (block) {
          const code = block[2].replace(/\n$/, "");
          return (
            <div key={i} className="chat-code">
              <div className="chat-code__bar">
                <span className="mono">{block[1] || "code"}</span>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => navigator.clipboard.writeText(code).then(() => notify.info("Copied"))}
                >
                  <Copy size={11} /> Copy
                </button>
                {reviewTarget && (
                  <button className="btn btn--sm" title={`Compare with ${reviewTarget.path}`} onClick={() => reviewTarget.onReview(code)}>
                    <FileDiff size={11} /> Review as diff
                  </button>
                )}
              </div>
              <pre data-selectable>{code}</pre>
            </div>
          );
        }
        return (
          <p key={i} className="chat-text" data-selectable>
            {part.split(/(`[^`\n]+`)/g).map((seg, j) =>
              seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? (
                <code key={j}>{seg.slice(1, -1)}</code>
              ) : (
                <span key={j}>{seg}</span>
              ),
            )}
          </p>
        );
      })}
    </>
  );
}

function Message({ m, reviewTarget }: { m: ChatMessage; reviewTarget?: ChatPanelProps["reviewTarget"] }) {
  return (
    <div className={`chat-msg chat-msg--${m.role}`}>
      <div className="chat-msg__head">
        <span className="label">{m.role === "user" ? "You" : "Neural"}</span>
        {m.model && (
          <span className={`tag ${m.fallback ? "tag--warn" : ""}`} title={m.fallback ? "The selected model was busy; this one answered" : undefined}>
            {m.model}
            {m.fallback ? " · fallback" : ""}
          </span>
        )}
        {m.tokens?.prompt != null && (
          <span className="muted mono chat-msg__tokens">
            {m.tokens.prompt}→{m.tokens.output ?? "?"} tok
          </span>
        )}
      </div>
      {m.sent && m.sent.length > 0 && (
        <div className="chat-msg__sent">
          <Paperclip size={10} /> Sent: {m.sent.join(" · ")}
        </div>
      )}
      <div className="chat-msg__body">
        {m.text ? <MessageText text={m.text} reviewTarget={m.role === "model" && !m.streaming ? reviewTarget : undefined} /> : null}
        {m.streaming && m.status && !m.text && <div className="chat-msg__status muted">{m.status}</div>}
        {m.streaming && <span className="chat-cursor" />}
        {m.error && (
          <div className="chat-msg__error">
            <AlertTriangle size={12} /> {m.error}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPanel({ compact, attachControls, reviewTarget }: ChatPanelProps) {
  const { messages, pending, preview, draft, busy, setDraft, send, cancel, detach, clear } = useNeural();
  const listRef = useRef<HTMLDivElement>(null);
  const totalBytes = preview.reduce((sum, p) => sum + p.bytes, 0);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className={`chat${compact ? " chat--compact" : ""}`}>
      <div className="chat__list" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty chat__empty">
            <BrainCircuit size={compact ? 22 : 32} strokeWidth={1} />
            <div>Ask about code, errors, files or Windows.</div>
            <div className="muted">NEURAL only sees what you attach. Nothing is read from disk on its own.</div>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} reviewTarget={reviewTarget} />
        ))}
      </div>

      <div className="chat__composer">
        {pending.length > 0 && (
          <div className="chat__attachments">
            {pending.map((a, i) => {
              const info = preview[i];
              const label = a.kind === "file" ? a.path.split(/[\\/]/).pop() : a.kind === "tree" ? "Project file list" : a.label;
              return (
                <span key={i} className={`chip${info?.error ? " chip--error" : ""}`} title={info?.error ?? info?.label}>
                  <Paperclip size={10} />
                  {label}
                  {info && !info.error && <span className="muted mono">{formatBytes(info.bytes)}</span>}
                  {info?.error && <span className="chip__err">{info.error}</span>}
                  <button aria-label="Remove attachment" onClick={() => detach(i)}>
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <span className="muted chat__total">Will send {formatBytes(totalBytes)} of context</span>
          </div>
        )}
        <textarea
          className="textarea chat__input"
          placeholder="Message NEURAL… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="chat__actions">
          {attachControls}
          <span className="chat__spacer" />
          {messages.length > 0 && (
            <button className="icon-btn icon-btn--sm" title="Clear conversation" onClick={clear} disabled={!!busy}>
              <Trash2 size={13} />
            </button>
          )}
          {busy ? (
            <button className="btn btn--sm btn--danger" onClick={cancel}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className="btn btn--primary btn--sm" onClick={() => void send()} disabled={!draft.trim()}>
              <Send size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
