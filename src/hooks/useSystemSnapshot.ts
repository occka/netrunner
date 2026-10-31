/**
 * Shared system-metrics poller. Polling runs only while at least one component
 * is subscribed, at the user-configured interval, and pauses while the window
 * is hidden. All widgets share a single backend request per tick.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/services/api";
import { useSettings } from "@/stores/settings";
import type { SystemSnapshot } from "@/types/entities";

export const HISTORY_LENGTH = 60;

interface History {
  cpu: number[];
  memory: number[];
  rx: number[];
  tx: number[];
  gpu: number[];
}

interface MonitorStore {
  subscribers: number;
  snapshot: SystemSnapshot | null;
  history: History;
  error: string | null;
}

export const useMonitor = create<MonitorStore>(() => ({
  subscribers: 0,
  snapshot: null,
  history: { cpu: [], memory: [], rx: [], tx: [], gpu: [] },
  error: null,
}));

let timer: number | undefined;
let inFlight = false;

function push(list: number[], value: number | null): number[] {
  if (value == null) return list;
  const next = list.length >= HISTORY_LENGTH ? list.slice(1) : list.slice();
  next.push(value);
  return next;
}

async function tick() {
  if (inFlight || document.hidden) return;
  inFlight = true;
  try {
    const snap = await api.system.snapshot();
    const { history } = useMonitor.getState();
    const memPct = snap.memory.totalBytes > 0 ? (snap.memory.usedBytes / snap.memory.totalBytes) * 100 : null;
    useMonitor.setState({
      snapshot: snap,
      error: null,
      history: {
        cpu: push(history.cpu, snap.cpu.usagePercent),
        memory: push(history.memory, memPct),
        rx: push(history.rx, snap.network.rxBytesPerSec),
        tx: push(history.tx, snap.network.txBytesPerSec),
        gpu: push(history.gpu, snap.gpu?.usagePercent ?? null),
      },
    });
  } catch (err) {
    useMonitor.setState({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}

function schedule() {
  window.clearInterval(timer);
  timer = undefined;
  if (useMonitor.getState().subscribers === 0) return;
  void tick();
  timer = window.setInterval(() => void tick(), useSettings.getState().values["monitor.interval_ms"]);
}

// Restart the timer when the user changes the interval.
useSettings.subscribe((state, prev) => {
  if (state.values["monitor.interval_ms"] !== prev.values["monitor.interval_ms"]) schedule();
});

/** Subscribes the calling component to live metrics. */
export function useSystemSnapshot() {
  useEffect(() => {
    useMonitor.setState((s) => ({ subscribers: s.subscribers + 1 }));
    if (useMonitor.getState().subscribers === 1) schedule();
    return () => {
      useMonitor.setState((s) => ({ subscribers: s.subscribers - 1 }));
      if (useMonitor.getState().subscribers === 0) schedule();
    };
  }, []);
  return useMonitor();
}
