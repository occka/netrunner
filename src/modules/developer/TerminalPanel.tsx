import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, SquareTerminal, X } from "lucide-react";
import { api } from "@/services/api";
import { closeTerminal, openTerminal, useTerminals } from "./terminals";
import { useDev } from "./store";
import type { ShellOption } from "@/types/dev";

/** Module-level guard: StrictMode runs effects twice, which must not open two shells. */
let autoOpening = false;

export function TerminalPanel() {
  const { sessions, active, setActive } = useTerminals();
  const root = useDev((s) => s.root);
  const toggle = useDev((s) => s.toggleTerminal);
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [menu, setMenu] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const session = sessions.find((s) => s.id === active);

  useEffect(() => {
    api.term.shells().then(setShells, () => setShells([{ id: "powershell", label: "Windows PowerShell" }]));
  }, []);

  // Open one terminal automatically the first time the panel is shown.
  useEffect(() => {
    if (autoOpening || shells.length === 0 || useTerminals.getState().sessions.length > 0) return;
    autoOpening = true;
    void openTerminal(shells[0].id, root, shells[0].label).finally(() => (autoOpening = false));
  }, [shells, root]);

  // Attach the active session's DOM node and keep it fitted to the panel.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !session) return;
    host.replaceChildren(session.host);
    const fit = () => {
      try {
        session.fit.fit();
      } catch {
        /* panel hidden */
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    session.term.focus();
    return () => ro.disconnect();
  }, [session]);

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs">
        <SquareTerminal size={13} className="muted" />
        <span className="label">Terminal</span>
        {sessions.map((s) => (
          <div key={s.id} className="terminal-tab" aria-selected={s.id === active} onClick={() => setActive(s.id)}>
            <span className={s.exited ? "muted" : undefined}>{s.title}</span>
            <button className="editor-tab__close" aria-label="Close terminal" onClick={(e) => (e.stopPropagation(), void closeTerminal(s.id))}>
              <X size={11} />
            </button>
          </div>
        ))}
        <div className="terminal-new">
          <button className="icon-btn icon-btn--sm" title="New terminal" onClick={() => setMenu((m) => !m)}>
            <Plus size={13} />
            <ChevronDown size={10} />
          </button>
          {menu && (
            <div className="menu terminal-menu" onMouseLeave={() => setMenu(false)}>
              {shells.map((s) => (
                <button
                  key={s.id}
                  className="menu__item"
                  onClick={() => {
                    setMenu(false);
                    void openTerminal(s.id, root, s.label);
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="terminal-cwd mono muted truncate">{root ?? "%USERPROFILE%"}</span>
        <button className="icon-btn icon-btn--sm" title="Hide panel (Ctrl+`)" onClick={() => toggle(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="terminal-body" ref={hostRef}>
        {sessions.length === 0 && <div className="empty">Starting terminal…</div>}
      </div>
    </div>
  );
}
