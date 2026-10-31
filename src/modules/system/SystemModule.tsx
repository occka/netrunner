import { Suspense, useEffect, useState } from "react";
import { ModuleHeader } from "@/components/ModuleHeader";
import { Tabs } from "@/components/Tabs";
import { api } from "@/services/api";
import { useShell } from "@/stores/shell";
import { WIDGETS } from "@/modules/command/widgets/registry";
import { Sampling } from "@/modules/command/widgets/common";
import { ProcessesTab } from "./ProcessesTab";
import { StartupTab } from "./StartupTab";
import { ServicesTab } from "./ServicesTab";
import { PowerTab } from "./PowerTab";
import type { SystemInfo } from "@/types/entities";

type Tab = "hardware" | "processes" | "startup" | "services" | "power";
const TABS: { id: Tab; label: string }[] = [
  { id: "hardware", label: "Hardware" },
  { id: "processes", label: "Processes" },
  { id: "startup", label: "Startup" },
  { id: "services", label: "Services" },
  { id: "power", label: "Power" },
];

const PANELS = ["system-overview", "cpu", "gpu", "ram", "storage", "thermal"] as const;

export default function SystemModule() {
  const section = useShell((s) => s.section);
  const [tab, setTab] = useState<Tab>((TABS.find((t) => t.id === section)?.id as Tab) ?? "hardware");
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    api.system.info().then(setInfo, () => setInfo(null));
  }, []);

  return (
    <div className="module">
      <ModuleHeader
        id="system"
        subtitle={
          info ? (
            <span className="mono">
              {info.hostName ?? "—"} · {info.osName ?? "Windows"} · {info.cpuBrand ?? "CPU"} · {info.physicalCores ?? "?"}C/
              {info.logicalCores}T
            </span>
          ) : undefined
        }
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="module__scroll">
        {tab === "hardware" && (
          <div className="system-grid">
            {PANELS.map((type) => {
              const def = WIDGETS[type];
              const Body = def.component!;
              return (
                <section key={type} className={`panel system-grid__${type}`}>
                  <header className="panel__header">
                    <h2 className="panel__title">{def.title}</h2>
                  </header>
                  <div className="panel__body">
                    <Suspense fallback={<Sampling />}>
                      <Body instanceId={`system-${type}`} editing={false} />
                    </Suspense>
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {tab === "processes" && <ProcessesTab />}
        {tab === "startup" && <StartupTab />}
        {tab === "services" && <ServicesTab />}
        {tab === "power" && <PowerTab />}
      </div>
    </div>
  );
}
