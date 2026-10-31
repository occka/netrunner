import { AlertTriangle } from "lucide-react";
import { useConfirm } from "@/stores/confirm";
import { Dialog } from "@/components/Dialog";

/** Renders the pending `confirmAction()` request, if any. */
export function ConfirmHost() {
  const request = useConfirm((s) => s.request);
  const settle = useConfirm((s) => s.settle);
  if (!request) return null;

  return (
    <Dialog
      title={request.title}
      danger={request.danger}
      icon={request.danger ? <AlertTriangle size={18} color="var(--c-critical)" /> : undefined}
      onClose={() => settle(false)}
      footer={
        <>
          <button className="btn" onClick={() => settle(false)} autoFocus>
            Cancel
          </button>
          <button className={`btn ${request.danger ? "btn--danger" : "btn--primary"}`} onClick={() => settle(true)}>
            {request.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{request.message}</p>
      {request.detail && (
        <pre className="confirm__detail" data-selectable>
          {request.detail}
        </pre>
      )}
    </Dialog>
  );
}
