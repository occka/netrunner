import { ModuleHeader } from "@/components/ModuleHeader";
import { MODULE_BY_ID } from "@/app/modules";
import { useShell } from "@/stores/shell";

/**
 * Screen for modules that are not implemented yet. States plainly that the
 * module is planned and what it will contain; it offers no fake controls.
 */
export default function PlannedModule() {
  const id = useShell((s) => s.module);
  const def = MODULE_BY_ID[id];

  return (
    <div className="module">
      <ModuleHeader id={id} />
      <div className="module__scroll">
        <div className="planned">
          <def.icon size={40} strokeWidth={1} className="planned__icon" />
          <div className="planned__phase">
            <span className="label">Scheduled</span>
            <span className="mono">PHASE {def.phase}</span>
          </div>
          <p className="planned__text">
            {def.label.toUpperCase()} is not implemented in this build. The navigation entry exists so the module structure
            is visible; no part of this screen performs actions yet.
          </p>
          <div className="planned-list">
            <div className="label">Planned capabilities</div>
            <ul>
              {def.planned.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
