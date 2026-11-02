import { useEffect, useState } from "react";
import { FlaskConical, Play, Settings2 } from "lucide-react";
import { api } from "@/services/api";
import { notify, reportError } from "@/stores/notifications";
import { useDev } from "./store";
import { loadConfigs, runTask, type RunConfig } from "./tasks";
import { LAUNCH_FILE, LAUNCH_TEMPLATE } from "./runConfigs";

/** Remembered choice per project for this app session. */
const chosen = new Map<string, string>();

/** Run ▶ / Test buttons with the project's run configurations. */
export function RunBar({ root }: { root: string }) {
  const revision = useDev((s) => s.revision);
  const [configs, setConfigs] = useState<RunConfig[]>([]);
  const [selected, setSelected] = useState<string>(chosen.get(root) ?? "");

  useEffect(() => {
    let alive = true;
    void loadConfigs(root).then(({ configs, error }) => {
      if (!alive) return;
      setConfigs(configs);
      if (error) notify.warn("Run configurations", error);
    });
    return () => {
      alive = false;
    };
  }, [root, revision]);

  const current = configs.find((c) => c.id === selected) ?? configs.find((c) => c.group === "run") ?? configs[0];
  const test = configs.find((c) => c.group === "test");

  const pick = (id: string) => {
    chosen.set(root, id);
    setSelected(id);
  };

  const editLaunch = async () => {
    const path = `${root}\\${LAUNCH_FILE}`;
    try {
      const exists = await api.dev.readFile(path).then(
        () => true,
        () => false,
      );
      if (!exists) {
        const dir = await api.dev.create(root, ".netrunner", true).catch(() => `${root}\\.netrunner`);
        await api.dev.create(dir, "launch.json", false);
        await api.dev.writeFile(path, LAUNCH_TEMPLATE);
        useDev.getState().bump();
      }
      await useDev.getState().openFile(path);
    } catch (err) {
      reportError("Could not open launch.json", err);
    }
  };

  return (
    <div className="run-bar">
      <select className="input run-bar__select" value={current?.id ?? ""} onChange={(e) => pick(e.target.value)} title="Run configuration" disabled={!configs.length}>
        {!configs.length && <option value="">No run configurations</option>}
        {(["run", "build", "test"] as const).map((g) => {
          const list = configs.filter((c) => c.group === g);
          return list.length ? (
            <optgroup key={g} label={g === "run" ? "Run" : g === "build" ? "Build" : "Test"}>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.source === "launch.json" ? " ★" : ""}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      <button className="icon-btn" title={current ? `Run: ${current.command}` : "Nothing to run"} disabled={!current} onClick={() => current && void runTask(current)}>
        <Play size={14} />
      </button>
      <button className="icon-btn" title={test ? `Test: ${test.command}` : "No test configuration"} disabled={!test} onClick={() => test && void runTask(test)}>
        <FlaskConical size={14} />
      </button>
      <button className="icon-btn" title={`Edit ${LAUNCH_FILE}`} onClick={() => void editLaunch()}>
        <Settings2 size={14} />
      </button>
    </div>
  );
}
