import { Suspense, useEffect } from "react";
import { MODULE_BY_ID, moduleComponent } from "@/app/modules";
import { useShell } from "@/stores/shell";
import { useSettings } from "@/stores/settings";
import { useQuickAccess } from "@/stores/quickAccess";
import { reportError } from "@/stores/notifications";
import { TopBar } from "@/layouts/TopBar";
import { NavRail } from "@/layouts/NavRail";
import { Inspector } from "@/layouts/Inspector";
import { StatusBar } from "@/layouts/StatusBar";
import { CommandPalette } from "@/layouts/CommandPalette";
import { ConfirmHost } from "@/components/ConfirmHost";
import { Toasts } from "@/components/Toasts";
import { EntryEditor } from "@/modules/quick-access/EntryEditor";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ContextMenuHost } from "@/components/ContextMenu";
import { useBackendEvents } from "@/hooks/useBackendEvents";
import { PromptHost } from "@/components/PromptHost";

export function AppShell() {
  const module = useShell((s) => s.module);
  const paletteOpen = useShell((s) => s.paletteOpen);
  const editor = useQuickAccess((s) => s.editor);
  const Module = moduleComponent(MODULE_BY_ID[module]);

  useGlobalHotkeys();
  useBackendEvents();

  return (
    <div className="shell">
      <TopBar />
      <div className="shell__main">
        <NavRail />
        <main className="workspace" id="workspace">
          <ErrorBoundary key={module}>
            <Suspense fallback={<div className="workspace__loading label">Loading module…</div>}>
              <Module />
            </Suspense>
          </ErrorBoundary>
        </main>
        <Inspector />
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette />}
      {editor && <EntryEditor />}
      <ContextMenuHost />
      <PromptHost />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}

function useGlobalHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k" || (key === "p" && e.shiftKey)) {
        e.preventDefault();
        const shell = useShell.getState();
        if (shell.paletteOpen) shell.closePalette();
        else shell.openPalette();
      } else if (key === "i" && !e.shiftKey) {
        e.preventDefault();
        const visible = useSettings.getState().values["inspector.visible"];
        useSettings
          .getState()
          .set("inspector.visible", !visible)
          .catch((err) => reportError("Could not save inspector state", err));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
