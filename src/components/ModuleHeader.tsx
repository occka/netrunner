import type { ReactNode } from "react";
import { MODULE_BY_ID, STATUS_LABEL, type ModuleId } from "@/app/modules";

const TONE = { implemented: "ok", partial: "info", planned: "warn" } as const;

export function ModuleHeader({ id, children, subtitle }: { id: ModuleId; children?: ReactNode; subtitle?: ReactNode }) {
  const def = MODULE_BY_ID[id];
  return (
    <div className="module-head">
      <div className="module-head__titles">
        <div className="module-head__row">
          <def.icon size={18} strokeWidth={1.6} className="module-head__icon" />
          <h1 className="module-head__title">{def.label}</h1>
          <span className={`tag tag--${TONE[def.status]}`}>{STATUS_LABEL[def.status]}</span>
        </div>
        <div className="module-head__sub">{subtitle ?? def.description}</div>
      </div>
      {children && <div className="module-head__actions">{children}</div>}
    </div>
  );
}
