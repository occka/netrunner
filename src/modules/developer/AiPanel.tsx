import { useEffect } from "react";
import { FileCode2, FolderTree, KeyRound, TextSelect } from "lucide-react";
import { useShell } from "@/stores/shell";
import { notify } from "@/stores/notifications";
import { ChatPanel } from "@/modules/neural/ChatPanel";
import { useNeural } from "@/modules/neural/store";
import { useNeuralSession } from "@/modules/neural/useNeuralSession";
import { getEditorSelection } from "./EditorArea";
import { useDev } from "./store";

/**
 * NEURAL inside DEVELOPER. Context is attached explicitly with the buttons
 * below; code blocks in replies can be opened as a reviewable diff against
 * the active file and applied only after confirmation.
 */
export function AiPanel({ root }: { root: string }) {
  useNeuralSession();
  const status = useNeural((s) => s.status);
  const loadStatus = useNeural((s) => s.loadStatus);
  const attach = useNeural((s) => s.attach);
  const activeFile = useDev((s) => s.tabs.find((t) => t.key === s.active && t.kind === "file"));

  useEffect(() => {
    if (!status) void loadStatus().catch(() => undefined);
  }, [status, loadStatus]);

  if (status && !status.configured) {
    return (
      <div className="ide-right__body">
        <div className="unavailable">
          <KeyRound size={14} />
          <span>Connect a Gemini API key in NEURAL to use the assistant here.</span>
        </div>
        <button className="btn btn--sm" onClick={() => useShell.getState().navigate("neural")}>
          Open NEURAL
        </button>
      </div>
    );
  }

  return (
    <ChatPanel
      compact
      reviewTarget={activeFile ? { path: activeFile.path, onReview: (code) => void useDev.getState().openProposal(activeFile.path, code) } : undefined}
      attachControls={
        <>
          <button
            className="icon-btn icon-btn--sm"
            title={activeFile ? `Attach ${activeFile.name}` : "Open a file to attach it"}
            disabled={!activeFile}
            onClick={() => activeFile && attach({ kind: "file", path: activeFile.path })}
          >
            <FileCode2 size={13} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            title="Attach the selected code"
            onClick={() => {
              const sel = getEditorSelection();
              if (sel) attach({ kind: "selection", ...sel });
              else notify.info("Select some code in the editor first");
            }}
          >
            <TextSelect size={13} />
          </button>
          <button className="icon-btn icon-btn--sm" title="Attach the project's file list (names only)" onClick={() => attach({ kind: "tree", root })}>
            <FolderTree size={13} />
          </button>
        </>
      }
    />
  );
}
