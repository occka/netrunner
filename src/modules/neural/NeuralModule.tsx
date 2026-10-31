import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileUp, KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { api } from "@/services/api";
import { confirmAction } from "@/stores/confirm";
import { notify, reportError } from "@/stores/notifications";
import { ChatPanel } from "./ChatPanel";
import { useNeural } from "./store";
import { ChatList } from "./ChatList";
import { useNeuralSession } from "./useNeuralSession";

export default function NeuralModule() {
  const { status, models, loadStatus, loadModels, disconnect, attach } = useNeural();
  const [projects, setProjects] = useState<string[]>([]);
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
      await api.settings.set("neural.model", model);
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
      <ModuleHeader id="neural" subtitle={status?.configured ? "Gemini via Google AI Studio · context is only what you attach" : undefined}>
        {status?.configured && (
          <>
            <select className="select neural-model" value={status.model} onChange={(e) => void setModel(e.target.value)} title="Model">
              {!models.some((m) => m.id === status.model) && <option value={status.model}>{status.model}</option>}
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
          <ChatPanel
            attachControls={
              <>
                <button className="btn btn--sm btn--ghost" onClick={() => void attachFile()} title="Attach text files (max 256 KB each)">
                  <FileUp size={12} /> Attach file
                </button>
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
            <ShieldCheck size={11} /> The AI never reads your disk. It only sees files, selections or project file lists
            you attach, and every send is recorded in the activity log.
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
