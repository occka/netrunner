import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, FolderOpen, KeyRound, LogOut, PanelRight, Save, ShieldCheck } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { ResizeHandle } from "@/components/ResizeHandle";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { ChatPanel } from "./ChatPanel";
import { useNeural } from "./store";
import { ChatFiles } from "./ChatFiles";
import { ChatList } from "./ChatList";
import { useNeuralSession } from "./useNeuralSession";

export default function NeuralModule() {
  const { status, models, mode, chatId, busy, loadStatus, loadModels, disconnect, attach, setMode, setDraft, send } = useNeural();
  const [projects, setProjects] = useState<string[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const selected = mode === "play" ? status?.playModel : status?.model;
  useNeuralSession();

  useEffect(() => {
    loadStatus().catch((e) => reportError("Could not read NEURAL status", e));
    api.dev.projects().then(setProjects, () => setProjects([]));
  }, [loadStatus]);

  useEffect(() => {
    if (status?.configured && models.length === 0) loadModels().catch(() => undefined);
  }, [status?.configured, models.length, loadModels]);

  const setModel = async (model: string) => {
    try {
      await api.settings.set(mode === "play" ? "neural.model_play" : "neural.model", model);
      await loadStatus();
    } catch (err) {
      reportError("Could not change model", err);
    }
  };

  const attachFile = async () => {
    const picked = await openDialog({ multiple: true, title: "Attach files for NEURAL" });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    list.forEach((path) => attach({ kind: "file", path }));
  };

  return (
    <div className="module">
      <ModuleHeader id="neural" subtitle={status?.configured ? "Gemini via Google AI Studio · sees what you attach and this chat's folder" : undefined}>
        {status?.configured && (
          <>
            <div className="segmented" role="group" aria-label="Mode of this chat">
              <button
                aria-pressed={mode === "work"}
                disabled={!!busy}
                title="Precise and concise, for code and tasks"
                onClick={() => void setMode("work").catch((e) => reportError("Could not change mode", e))}
              >
                Work
              </button>
              <button
                aria-pressed={mode === "play"}
                disabled={!!busy}
                title="Creative: conversation and role-playing games with real dice. Uses its own model, with a larger free quota"
                onClick={() => void setMode("play").catch((e) => reportError("Could not change mode", e))}
              >
                Play
              </button>
            </div>
            <button className="btn btn--ghost" aria-pressed={showFiles} onClick={() => setShowFiles((v) => !v)} title="Files in this chat's folder">
              <PanelRight size={14} /> Files
            </button>
            <select className="select neural-model" value={selected} onChange={(e) => void setModel(e.target.value)} title={`Model for ${mode === "play" ? "Play" : "Work"}`}>
              {selected && !models.some((m) => m.id === selected) && <option value={selected}>{selected}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
            <button
              className="btn btn--ghost"
              onClick={async () => {
                if (await confirmAction({ title: "Remove API key", message: "Remove the Gemini API key from Windows Credential Manager?", confirmLabel: "Remove", danger: true }))
                  await disconnect().catch((e) => reportError("Could not remove key", e));
              }}
            >
              <LogOut size={14} /> Disconnect
            </button>
          </>
        )}
      </ModuleHeader>
      {status && !status.configured ? (
        <div className="module__scroll">
          <Connect />
        </div>
      ) : (
        <div className="neural-body">
          <ChatList />
          <ResizeHandle pane="neural-chats" of="prev" min={160} max={600} rest={360} />
          <ChatPanel
            attachControls={
              <>
                <button className="btn btn--sm btn--ghost" onClick={() => void attachFile()} title="Attach text files (max 256 KB each)">
                  <FileUp size={12} /> Attach file
                </button>
                {mode === "play" && (
                  <button
                    className="btn btn--sm btn--ghost"
                    disabled={!!busy}
                    title="Ask NEURAL to save the current state to its files"
                    onClick={() => {
                      setDraft("Save the current state to your files now: everything that changed, then a one-line confirmation. Keep replying in the language we have been using.");
                      void send(true);
                    }}
                  >
                    <Save size={12} /> Update files
                  </button>
                )}
                {projects.length > 0 && (
                  <select
                    className="select neural-tree"
                    value=""
                    onChange={(e) => e.target.value && attach({ kind: "tree", root: e.target.value })}
                    title="Attach a project's file list (names only, no contents)"
                  >
                    <option value="">Attach project file list…</option>
                    {projects.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                )}
              </>
            }
          />
          {showFiles && chatId != null && (
            <>
              <ResizeHandle pane="neural-files" of="next" min={180} max={700} rest={360} />
              <ChatFiles chatId={chatId} onOpen={() => void api.neural.openFolder(chatId).catch((e) => reportError("Could not open the folder", e))} icon={<FolderOpen size={12} />} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Connect() {
  const connect = useNeural((s) => s.connect);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connect(key);
      setKey("");
      notify.success("NEURAL connected", "Gemini API key stored in Windows Credential Manager");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel gh-connect">
      <header className="panel__header">
        <h2 className="panel__title">Connect Gemini</h2>
      </header>
      <form className="panel__body gh-connect__body" onSubmit={(e) => void submit(e)}>
        <p>
          Paste a Google AI Studio API key (aistudio.google.com → Get API key). NEURAL works without it; everything else in
          NETRUNNER keeps working.
        </p>
        <ul className="muted">
          <li>The key is checked against Google, then stored only in Windows Credential Manager. It is not shown again.</li>
          <li>Requests send the key in a header, never in a URL.</li>
          <li>
            <ShieldCheck size={11} /> The AI sees only what you attach and its own folder for each chat, and every send
            is recorded in the activity log. On the free tier Google may use what you send to improve its products, and
            human reviewers may read it: do not send anything sensitive.
          </li>
        </ul>
        <label className="field">
          <span className="label">API key</span>
          <input className="input input--mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza… / AQ.…" />
        </label>
        {error && <div className="field__error">{error}</div>}
        <div>
          <button className="btn btn--primary" type="submit" disabled={busy || key.trim().length < 20}>
            <KeyRound size={14} /> {busy ? "Verifying…" : "Connect"}
          </button>
        </div>
      </form>
    </section>
  );
}
