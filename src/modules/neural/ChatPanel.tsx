import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AlertTriangle, BrainCircuit, Code2, Copy, Dices, FileDiff, FilePen, ImagePlus, Paperclip, Pin, PinOff, Send, Square, Trash2, Undo2, X } from "lucide-react";
import { api } from "@/services/api";
import { notify, reportError } from "@/stores/notifications";
import type { Attachment, NeuralAction } from "@/types/neural";
import { formatBytes } from "@/utils/format";
import { IMAGE_FILE } from "./images";
import { useNeural, type ChatMessage } from "./store";

/** Tokens in one request that a long chat stays under (see HISTORY_BUDGET in the backend). */
const CONTEXT_TOKENS = 80_000;

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

function Photo({ name, className }: { name: string; className: string }) {
  const chatId = useNeural((s) => s.chatId);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (chatId != null) api.neural.imageRead(chatId, name).then(setSrc, () => setSrc(null));
  }, [chatId, name]);
  return src ? <img className={className} src={src} alt="Attached photo" /> : <span className={`${className} ${className}--missing`} />;
}

function ActionCard({ a, messageId }: { a: NeuralAction; messageId: number }) {
  const undo = useNeural((s) => s.undo);
  const Icon = a.kind === "dice" ? Dices : a.kind === "python" ? Code2 : FilePen;
  const verb = a.kind === "dice" ? "Rolled" : a.kind === "python" ? "Ran" : a.kind === "write" ? "Saved" : a.kind === "append" ? "Added to" : "Edited";
  const undone = a.error === "Undone";
  return (
    <details className={`chat-action${a.error && !undone ? " chat-action--error" : ""}`}>
      <summary>
        <Icon size={12} />
        <span className="truncate">
          {verb} <span className="mono">{a.label}</span>
        </span>
        {(a.added > 0 || a.removed > 0) && (
          <span className="mono muted">
            +{a.added} −{a.removed}
          </span>
        )}
        {a.error && <span className={undone ? "muted" : "chat-action__err"}>{a.error}</span>}
        {a.change != null && (
          <button
            className="btn btn--ghost btn--sm chat-action__undo"
            title="Return this file to how it was before this change"
            onClick={(e) => {
              e.preventDefault();
              if (a.change != null) void undo(messageId, a.change).catch((err) => reportError("Could not undo", err));
            }}
          >
            <Undo2 size={11} /> Undo
          </button>
        )}
      </summary>
      {a.detail && <pre data-selectable>{a.detail}</pre>}
    </details>
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
        {m.dropped != null && m.dropped > 0 && (
          <span className="tag" title="This chat is long: older messages were not sent. The agent relies on its files for them.">
            {m.dropped} older not sent
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
      {m.images && m.images.length > 0 && (
        <div className="chat-msg__photos">
          {m.images.map((name) => (
            <Photo key={name} name={name} className="chat-photo" />
          ))}
        </div>
      )}
      {m.actions && m.actions.length > 0 && (
        <div className="chat-actions">
          {m.actions.map((a, i) => (
            <ActionCard key={i} a={a} messageId={m.id} />
          ))}
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

function attachmentLabel(a: Attachment) {
  return a.kind === "file" ? a.path.split(/[\\/]/).pop() : a.kind === "tree" ? "Project file list" : a.kind === "image" ? "Photo" : a.label;
}

export function ChatPanel({ compact, attachControls, reviewTarget }: ChatPanelProps) {
  const { messages, pending, kept, preview, draft, busy, mode, setDraft, send, cancel, detach, clear, keep, unkeep, attach, attachPhoto } = useNeural();
  const listRef = useRef<HTMLDivElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const totalBytes = preview.reduce((sum, p) => sum + p.bytes, 0);
  const agent = !compact;
  const lastTokens = [...messages].reverse().find((m) => m.tokens?.prompt != null)?.tokens?.prompt;

  const addPhoto = (blob: Blob) => void attachPhoto(blob).catch((err) => reportError("Could not attach the photo", err));

  // Files dropped on the window arrive as paths: the webview handles the drag itself.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      // Only a drop on this panel counts; DEVELOPER has a chat panel of its own.
      const box = listRef.current?.parentElement?.getBoundingClientRect();
      const [x, y] = [e.payload.position.x / devicePixelRatio, e.payload.position.y / devicePixelRatio];
      if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      for (const path of e.payload.paths) {
        if (IMAGE_FILE.test(path)) {
          api.neural
            .imageFromPath(path)
            .then((url) => fetch(url))
            .then((r) => r.blob())
            .then(addPhoto, (err) => reportError("Could not read the image", err));
        } else {
          attach({ kind: "file", path });
        }
      }
    });
    return () => void un.then((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            {agent && mode === "play" ? (
              <>
                <div>Talk, or ask to play: a role-playing game, with real dice.</div>
                <div className="muted">NEURAL keeps its notes in this chat's own folder and sees nothing else on your PC.</div>
              </>
            ) : (
              <>
                <div>Ask about code, errors, files or Windows.</div>
                <div className="muted">{agent ? "NEURAL sees what you attach and this chat's own folder. Nothing else on your PC." : "NEURAL only sees what you attach. Nothing is read from disk on its own."}</div>
              </>
            )}
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} reviewTarget={reviewTarget} />
        ))}
      </div>

      <div className="chat__composer">
        {pending.length + kept.length > 0 && (
          <div className="chat__attachments">
            {pending.map((a, i) => {
              const info = preview[i];
              return (
                <span key={`p${i}`} className={`chip${info?.error ? " chip--error" : ""}`} title={info?.error ?? "Goes only with the next message"}>
                  {a.kind === "image" ? <Photo name={a.name} className="chip__photo" /> : <Paperclip size={10} />}
                  {attachmentLabel(a)}
                  {info && !info.error && <span className="muted mono">{formatBytes(info.bytes)}</span>}
                  {info?.error && <span className="chip__err">{info.error}</span>}
                  {!info?.error && (
                    <button aria-label="Keep in context" title="Keep in context: send it with every message of this chat" onClick={() => void keep(i).catch((err) => reportError("Could not keep it", err))}>
                      <Pin size={10} />
                    </button>
                  )}
                  <button aria-label="Remove attachment" onClick={() => detach(i)}>
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            {kept.map((a, i) => {
              const info = preview[pending.length + i];
              return (
                <span key={`k${i}`} className={`chip chip--kept${info?.error ? " chip--error" : ""}`} title={info?.error ?? "Kept in context: sent with every message, read fresh each time"}>
                  {a.kind === "image" ? <Photo name={a.name} className="chip__photo" /> : <Pin size={10} />}
                  {attachmentLabel(a)}
                  {info && !info.error && <span className="muted mono">{formatBytes(info.bytes)}</span>}
                  {info?.error && <span className="chip__err">{info.error}</span>}
                  <button aria-label="Stop keeping in context" title="Stop keeping in context" onClick={() => void unkeep(i).catch((err) => reportError("Could not change it", err))}>
                    <PinOff size={10} />
                  </button>
                </span>
              );
            })}
            <span className="muted chat__total">
              Will send {formatBytes(totalBytes)}
              {pending.length > 0 && " · attachments go only with this message unless pinned"}
            </span>
          </div>
        )}
        <textarea
          className="textarea chat__input"
          placeholder="Message NEURAL… (Enter to send, Shift+Enter for a new line)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const photos = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (photos.length) {
              e.preventDefault();
              photos.forEach(addPhoto);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(agent);
            }
          }}
        />
        <div className="chat__actions">
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              [...(e.target.files ?? [])].forEach(addPhoto);
              e.target.value = "";
            }}
          />
          <button className="btn btn--sm btn--ghost" onClick={() => photoInput.current?.click()} title="Attach photos (or paste with Ctrl+V, or drop them here). They are shrunk and their metadata is removed.">
            <ImagePlus size={12} /> Photo
          </button>
          {attachControls}
          <span className="chat__spacer" />
          {agent && lastTokens != null && (
            <span className="muted mono chat__context" title="How much of a request this chat takes. Past the limit, the oldest messages stop being sent.">
              {Math.round(lastTokens / 1000)}K / {CONTEXT_TOKENS / 1000}K
            </span>
          )}
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
            <button className="btn btn--primary btn--sm" onClick={() => void send(agent)} disabled={!draft.trim() && !pending.some((a) => a.kind === "image")}>
              <Send size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
