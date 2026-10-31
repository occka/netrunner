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
  gpu: GpuMetrics | null;
  diskIo: DiskIo | null;
}

export interface ProcessList {
  cpuValid: boolean;
  processes: ProcessInfo[];
}

import type { DiskIo, GpuMetrics, ProcessInfo } from "./phase2";
