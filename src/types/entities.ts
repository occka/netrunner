/** Types mirroring the Rust command payloads (serde camelCase). */

export type EntryKind = "app" | "game" | "file" | "folder" | "website" | "command" | "project";
export type CommandShell = "" | "cmd" | "powershell";

export interface QuickAccessEntry {
  id: number;
  kind: EntryKind;
  name: string;
  target: string;
  args: string;
  workingDir: string;
  shell: CommandShell;
  icon: string;
  category: string;
  favorite: boolean;
  requireConfirm: boolean;
  sortOrder: number;
  /** null: shown in every profile. */
  profileId: number | null;
  /** Global key, e.g. Ctrl+Alt+1; empty means none. */
  hotkey: string;
  launchCount: number;
  lastLaunchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuickAccessInput {
  kind: EntryKind;
  name: string;
  target: string;
  args: string;
  workingDir: string;
  shell: CommandShell;
  icon: string;
  category: string;
  favorite: boolean;
  requireConfirm: boolean;
  profileId: number | null;
  hotkey: string;
}

export interface HotkeyBinding {
  id: string;
  label: string;
  keys: string;
  default: string | null;
  global: boolean;
  entryId: number | null;
  error: string | null;
}

export interface CommandAssessment {
  dangerous: boolean;
  reasons: string[];
}

export type ProfileKind = "default" | "development" | "gaming" | "media" | "custom";

export interface WidgetInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Widget settings that differ from the defaults (see widgets/settings.ts). */
  config?: Record<string, unknown>;
}

export interface DashboardLayout {
  version: 1;
  widgets: WidgetInstance[];
}

export interface Profile {
  id: number;
  name: string;
  kind: ProfileKind;
  isBuiltin: boolean;
  layout: DashboardLayout;
  createdAt: string;
  updatedAt: string;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: number | null;
}

export interface ActivityEntry {
  id: number;
  ts: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

export interface DbBackup {
  name: string;
  path: string;
  size: number;
  /** Seconds since 1970. */
  created: number;
  kind: "manual" | "auto" | "migration" | "damaged" | "restore";
}

export interface AppInfo {
  version: string;
  dataDir: string;
  databasePath: string | null;
  schemaVersion: number;
}

export interface SystemInfo {
  hostName: string | null;
  osName: string | null;
  osVersion: string | null;
  kernelVersion: string | null;
  cpuBrand: string | null;
  physicalCores: number | null;
  logicalCores: number;
}

export interface SystemSnapshot {
  timestampMs: number;
  uptimeSecs: number;
  cpu: {
    usagePercent: number | null;
    perCorePercent: number[];
    frequencyMhz: number | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disks: {
    name: string;
    mountPoint: string;
    fileSystem: string;
    kind: string;
    removable: boolean;
    totalBytes: number;
    availableBytes: number;
  }[];
  network: {
    rxBytesPerSec: number | null;
    txBytesPerSec: number | null;
    interfaces: {
      name: string;
      rxBytesPerSec: number | null;
      txBytesPerSec: number | null;
      totalRxBytes: number;
      totalTxBytes: number;
      addresses: string[];
    }[];
  };
  temperatures: { label: string; celsius: number }[];
  /** From HWiNFO, when that optional source is on and running. */
  sensors: {
    cpu: number | null;
    gpu: number | null;
    temperatures: { label: string; celsius: number }[];
    fans: { label: string; rpm: number }[];
  } | null;
  gpu: GpuMetrics | null;
  diskIo: DiskIo | null;
}

export interface ProcessList {
  cpuValid: boolean;
  processes: ProcessInfo[];
}

import type { DiskIo, GpuMetrics, ProcessInfo } from "./phase2";
