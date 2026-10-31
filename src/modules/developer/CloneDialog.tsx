import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { api } from "@/services/api";
import { notify } from "@/stores/notifications";
import { useDev } from "./store";

/** Clone dialog, kept free of Monaco imports so GITHUB can use it cheaply. */
export function CloneDialog({ onClose, initialUrl = "" }: { onClose: () => void; initialUrl?: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [parent, setParent] = useState("");
  const [name, setName] = useState(() => initialUrl.split("/").pop()?.replace(/\.git$/, "") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const root = await api.git.clone(url.trim(), parent, name.trim());
      notify.success("Repository cloned", root);
      await useDev.getState().openProject(root);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Clone repository"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="clone-form" disabled={busy || !url || !parent || !name}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </>
      }
    >
      <form id="clone-form" className="form-grid" onSubmit={(e) => void submit(e)}>
        <label className="field form-grid__full">
          <span className="label">Repository URL (https)</span>
          <input
            className="input input--mono"
            value={url}
            placeholder="https://github.com/owner/repo.git"
            onChange={(e) => {
              setUrl(e.target.value);
              if (!name) setName(e.target.value.split("/").pop()?.replace(/\.git$/, "") ?? "");
            }}
            required
          />
        </label>
        <label className="field">
          <span className="label">Into folder</span>
          <div className="input-row">
            <input className="input input--mono" value={parent} readOnly placeholder="Choose…" />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const dir = await openDialog({ directory: true, multiple: false, title: "Clone into" });
                if (typeof dir === "string") setParent(dir);
              }}
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </label>
        <label className="field">
          <span className="label">Folder name</span>
          <input className="input input--mono" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <div className="field__hint form-grid__full">
          Private repositories authenticate through Git Credential Manager (installed with Git for Windows).
        </div>
        {error && <div className="field__error form-grid__full">{error}</div>}
      </form>
    </Dialog>
  );
}
