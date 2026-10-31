import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderSearch } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { api } from "@/services/api";
import { emptyInput, useQuickAccess } from "@/stores/quickAccess";
import { useShell } from "@/stores/shell";
import { notify } from "@/stores/notifications";
import { ENTRY_KIND_META, ENTRY_KINDS, ICON_CHOICES } from "./entryMeta";
import type { CommandAssessment, EntryKind, QuickAccessInput } from "@/types/entities";

/** The universal ADD OBJECT / edit dialog for Quick Access entries. */
export function EntryEditor() {
  const editor = useQuickAccess((s) => s.editor)!;
  const close = useQuickAccess((s) => s.closeEditor);
  const existing = useQuickAccess((s) => s.entries.find((e) => e.id === editor.id));
  const [form, setForm] = useState<QuickAccessInput>(() =>
    existing
      ? {
          kind: existing.kind,
          name: existing.name,
          target: existing.target,
          args: existing.args,
          workingDir: existing.workingDir,
          shell: existing.shell,
          icon: existing.icon,
          category: existing.category,
          favorite: existing.favorite,
          requireConfirm: existing.requireConfirm,
        }
      : { ...emptyInput(editor.initial?.kind), ...editor.initial },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [assessment, setAssessment] = useState<CommandAssessment | null>(null);
  const meta = ENTRY_KIND_META[form.kind];
  const set = <K extends keyof QuickAccessInput>(key: K, value: QuickAccessInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Live danger assessment for commands (same rules the backend enforces).
  useEffect(() => {
    if (form.kind !== "command" || !form.target.trim()) {
      setAssessment(null);
      return;
    }
    const id = window.setTimeout(() => {
      api.quickAccess.assessCommand(form.target).then(setAssessment, () => setAssessment(null));
    }, 250);
    return () => window.clearTimeout(id);
  }, [form.kind, form.target]);

  const changeKind = (kind: EntryKind) =>
    setForm((f) => ({
      ...f,
      kind,
      shell: kind === "command" ? f.shell || "powershell" : "",
      requireConfirm: kind === "command" ? true : f.requireConfirm,
    }));

  const browse = async (field: "target" | "workingDir") => {
    const directory = field === "workingDir" || form.kind === "folder" || form.kind === "project";
    const filters =
      !directory && (form.kind === "app" || form.kind === "game")
        ? [
            { name: "Programs", extensions: ["exe", "lnk", "bat", "cmd", "url"] },
            { name: "All files", extensions: ["*"] },
          ]
        : undefined;
    const picked = await openDialog({ directory, multiple: false, filters });
    if (typeof picked !== "string") return;
    setForm((f) => {
      const next = { ...f, [field]: picked };
      if (field === "target" && !f.name.trim()) {
        const base = picked.split(/[\\/]/).filter(Boolean).pop() ?? "";
        next.name = base.replace(/\.(exe|lnk|bat|cmd|url)$/i, "");
      }
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const store = useQuickAccess.getState();
      const entry = existing ? await store.update(existing.id, form) : await store.create(form);
      useShell.getState().select({ type: "qa-entry", id: entry.id });
      notify.success(existing ? "Entry updated" : "Entry added", entry.name);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const pathKind = form.kind !== "website" && form.kind !== "command";
  const supportsArgs = form.kind === "app" || form.kind === "game";
  const supportsWorkingDir = form.kind === "app" || form.kind === "game" || form.kind === "command";

  return (
    <Dialog
      title={existing ? "Edit object" : "Add object"}
      wide
      onClose={close}
      footer={
        <>
          <button className="btn" type="button" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit" form="entry-form" disabled={saving}>
            {saving ? "Saving…" : existing ? "Save changes" : "Add object"}
          </button>
        </>
      }
    >
      <form id="entry-form" className="form-grid" onSubmit={(e) => void submit(e)}>
        <div className="field form-grid__full">
          <span className="label">Type</span>
          <div className="kind-picker" role="radiogroup">
            {ENTRY_KINDS.map((k) => {
              const m = ENTRY_KIND_META[k];
              return (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={form.kind === k}
                  className="kind-picker__item"
                  onClick={() => changeKind(k)}
                >
                  <m.icon size={16} strokeWidth={1.5} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <label className="field">
          <span className="label">Display name</span>
          <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} required />
        </label>
        <label className="field">
          <span className="label">Category</span>
          <input
            className="input"
            value={form.category}
            onChange={(e) => set("category", e.target.value)}
            placeholder="e.g. Work, Media, Tools"
          />
        </label>

        <label className="field form-grid__full">
          <span className="label">{meta.targetLabel}</span>
          {form.kind === "command" ? (
            <textarea
              className="textarea"
              value={form.target}
              onChange={(e) => set("target", e.target.value)}
              placeholder={meta.targetPlaceholder}
              spellCheck={false}
              required
            />
          ) : (
            <div className="input-row">
              <input
                className="input input--mono"
                value={form.target}
                onChange={(e) => set("target", e.target.value)}
                placeholder={meta.targetPlaceholder}
                spellCheck={false}
                required
              />
              {pathKind && (
                <button type="button" className="btn" onClick={() => void browse("target")}>
                  <FolderSearch size={14} /> Browse
                </button>
              )}
            </div>
          )}
          {form.kind === "app" && (
            <span className="field__hint">Environment variables like %LOCALAPPDATA% are expanded at launch.</span>
          )}
          {form.kind === "game" && (
            <span className="field__hint">
              Launcher URIs allowed: steam://, com.epicgames.launcher://, goggalaxy://, uplay://, origin://, battlenet://
            </span>
          )}
          {form.kind === "project" && (
            <span className="field__hint">Opens the folder in Explorer until the DEVELOPER module (Phase 3) arrives.</span>
          )}
        </label>

        {form.kind === "command" && (
          <>
            <div className="field">
              <span className="label">Shell</span>
              <div className="segmented">
                {(["powershell", "cmd"] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={form.shell === s} onClick={() => set("shell", s)}>
                    {s === "powershell" ? "PowerShell" : "CMD"}
                  </button>
                ))}
              </div>
              <span className="field__hint">Runs in a new, visible console window.</span>
            </div>
            <div className="field">
              <span className="label">Safety</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.requireConfirm || !!assessment?.dangerous}
                  disabled={!!assessment?.dangerous}
                  onChange={(e) => set("requireConfirm", e.target.checked)}
                />
                Ask for confirmation before running
              </label>
            </div>
            {assessment?.dangerous && (
              <div className="danger-note form-grid__full">
                <AlertTriangle size={15} />
                <div>
                  <div className="label">Flagged as high-risk — confirmation is always required</div>
                  <div>This command {assessment.reasons.join(", ")}.</div>
                </div>
              </div>
            )}
          </>
        )}

        {supportsArgs && (
          <label className="field">
            <span className="label">Arguments</span>
            <input
              className="input input--mono"
              value={form.args}
              onChange={(e) => set("args", e.target.value)}
              placeholder="--profile work"
              spellCheck={false}
            />
          </label>
        )}
        {supportsWorkingDir && (
          <label className="field">
            <span className="label">Working directory</span>
            <div className="input-row">
              <input
                className="input input--mono"
                value={form.workingDir}
                onChange={(e) => set("workingDir", e.target.value)}
                placeholder={form.kind === "command" ? "Default: NETRUNNER's directory" : "Default: target's folder"}
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={() => void browse("workingDir")} aria-label="Browse working directory">
                <FolderSearch size={14} />
              </button>
            </div>
          </label>
        )}

        <div className="field">
          <span className="label">Icon</span>
          <select className="select" value={form.icon} onChange={(e) => set("icon", e.target.value)}>
            <option value="">Default ({meta.label})</option>
            {Object.keys(ICON_CHOICES).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <span className="field__hint">Executable icon extraction is planned (Phase 2).</span>
        </div>
        <div className="field">
          <span className="label">Options</span>
          <label className="check">
            <input type="checkbox" checked={form.favorite} onChange={(e) => set("favorite", e.target.checked)} />
            Favorite (pinned first)
          </label>
        </div>

        {error && <div className="field__error form-grid__full">{error}</div>}
      </form>
    </Dialog>
  );
}
