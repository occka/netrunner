/**
 * Dashboard widget registry. To add a widget: create a component under
 * ./ that accepts `WidgetProps`, then add an entry here. See docs/DEVELOPMENT.md.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  Activity,
  BrainCircuit,
  CalendarClock,
  Code2,
  Cpu,
  Gauge,
  HardDrive,
  Image,
  ListTree,
  MemoryStick,
  Monitor,
  Music,
  Network,
  Rocket,
  Thermometer,
  type LucideIcon,
} from "lucide-react";
import {
  ACTIVITY_SETTINGS,
  CLOCK_SETTINGS,
  CPU_SETTINGS,
  FRAME_SETTINGS,
  GPU_SETTINGS,
  IMAGE_SETTINGS,
  MUSIC_SETTINGS,
  NETWORK_SETTINGS,
  QUICK_ACCESS_SETTINGS,
  RAM_SETTINGS,
  STORAGE_SETTINGS,
  SYSTEM_OVERVIEW_SETTINGS,
  TASKS_SETTINGS,
  resolveConfig,
  type RawConfig,
  type WidgetSchema,
} from "./settings";

/** `C` is the widget's resolved settings, e.g. `WidgetProps<ConfigOf<typeof CLOCK_SETTINGS>>`. */
export interface WidgetProps<C = RawConfig> {
  instanceId: string;
  editing: boolean;
  /** Stored settings merged over the schema defaults (never undefined values). */
  config: C;
  /** Where the widget is rendered; overlays are smaller and float over other apps. */
  host: "dashboard" | "overlay";
}

/**
 * live        – real data, fully working
 * unavailable – widget exists but no reliable data provider yet (says so)
 * planned     – not implemented; cannot be added
 */
export type WidgetStatus = "live" | "unavailable" | "planned";

export interface WidgetDef {
  type: string;
  title: string;
  description: string;
  icon: LucideIcon;
  status: WidgetStatus;
  /** Where the data comes from, shown in the Inspector. */
  dataSource: string;
  keywords: string[];
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** Content settings (frame settings are added for every widget). */
  settings?: WidgetSchema;
  // `any`: each widget narrows its own config type.
  component?: LazyExoticComponent<ComponentType<WidgetProps<any>>>;
}

export const WIDGET_STATUS_LABEL: Record<WidgetStatus, string> = {
  live: "Live data",
  unavailable: "No provider",
  planned: "Planned",
};

const defs: WidgetDef[] = [
  {
    type: "system-overview",
    title: "System Overview",
    description: "CPU, memory, storage, network and sensors at a glance.",
    icon: Gauge,
    status: "live",
    dataSource: "Windows performance data via sysinfo. GPU, temperatures and fans show as unavailable unless the OS exposes them.",
    keywords: ["hardware", "metrics", "performance", "temperature"],
    defaultSize: { w: 5, h: 9 },
    minSize: { w: 3, h: 6 },
    settings: SYSTEM_OVERVIEW_SETTINGS,
    component: lazy(() => import("./SystemOverviewWidget")),
  },
  {
    type: "cpu",
    title: "CPU Monitor",
    description: "Total and per-core processor usage with history.",
    icon: Cpu,
    status: "live",
    dataSource: "Processor time sampled between polls (sysinfo). Frequency is the OS-reported value, often the base clock.",
    keywords: ["processor", "cores", "usage", "load"],
    defaultSize: { w: 4, h: 7 },
    minSize: { w: 3, h: 5 },
    settings: CPU_SETTINGS,
    component: lazy(() => import("./CpuWidget")),
  },
  {
    type: "gpu",
    title: "GPU Monitor",
    description: "Graphics usage, memory and temperature.",
    icon: Monitor,
    status: "live",
    dataSource:
      "Windows GPU performance counters (3D engine utilisation, dedicated memory), the same source Task Manager uses. Temperature is not exposed there and is not shown.",
    keywords: ["graphics", "video", "vram", "nvidia", "amd"],
    defaultSize: { w: 3, h: 6 },
    minSize: { w: 2, h: 4 },
    settings: GPU_SETTINGS,
    component: lazy(() => import("./GpuWidget")),
  },
  {
    type: "ram",
    title: "RAM Monitor",
    description: "Physical memory and page file usage.",
    icon: MemoryStick,
    status: "live",
    dataSource: "Windows memory status via sysinfo.",
    keywords: ["memory", "swap", "page file"],
    defaultSize: { w: 4, h: 6 },
    minSize: { w: 3, h: 5 },
    settings: RAM_SETTINGS,
    component: lazy(() => import("./RamWidget")),
  },
  {
    type: "storage",
    title: "Storage Monitor",
    description: "Capacity and free space per volume.",
    icon: HardDrive,
    status: "live",
    dataSource: "Mounted volumes via sysinfo. Total read/write throughput is shown in System Overview.",
    keywords: ["disk", "drive", "ssd", "space", "volume"],
    defaultSize: { w: 5, h: 7 },
    minSize: { w: 3, h: 4 },
    settings: STORAGE_SETTINGS,
    component: lazy(() => import("./StorageWidget")),
  },
  {
    type: "network",
    title: "Network Status",
    description: "Adapter throughput and addresses.",
    icon: Network,
    status: "live",
    dataSource:
      "Per-adapter byte counters via sysinfo; connectivity from Windows' network connectivity hint. VPN shown only as 'VPN-type adapter up', never as a protection claim.",
    keywords: ["internet", "throughput", "bandwidth", "vpn", "adapter"],
    defaultSize: { w: 4, h: 7 },
    minSize: { w: 3, h: 5 },
    settings: NETWORK_SETTINGS,
    component: lazy(() => import("./NetworkWidget")),
  },
  {
    type: "quick-access",
    title: "Quick Access",
    description: "Launch applications, folders, websites and commands.",
    icon: Rocket,
    status: "live",
    dataSource: "Your Quick Access entries (local database).",
    keywords: ["launcher", "apps", "shortcuts", "favorites"],
    defaultSize: { w: 4, h: 9 },
    minSize: { w: 2, h: 4 },
    settings: QUICK_ACCESS_SETTINGS,
    component: lazy(() => import("./QuickAccessWidget")),
  },
  {
    type: "developer",
    title: "Developer Workspace",
    description: "Recent projects, files, repositories and Git status.",
    icon: Code2,
    status: "planned",
    dataSource: "Arrives with the DEVELOPER and GITHUB modules (Phase 3).",
    keywords: ["projects", "git", "code", "ide"],
    defaultSize: { w: 5, h: 8 },
    minSize: { w: 3, h: 5 },
  },
  {
    type: "tasks",
    title: "Active Tasks",
    description: "Top running processes by CPU and memory.",
    icon: ListTree,
    status: "live",
    dataSource: "Running processes via sysinfo (read-only). Process control is planned for the SYSTEM module.",
    keywords: ["processes", "task manager", "running"],
    defaultSize: { w: 5, h: 9 },
    minSize: { w: 3, h: 5 },
    settings: TASKS_SETTINGS,
    component: lazy(() => import("./TasksWidget")),
  },
  {
    type: "neural",
    title: "Neural Chat",
    description: "Gemini assistant with your saved chats. Works as a floating overlay too.",
    icon: BrainCircuit,
    status: "live",
    dataSource: "Gemini via your API key. Only messages and files you attach are sent; chats are stored locally.",
    keywords: ["ai", "gemini", "assistant", "chat", "neural"],
    defaultSize: { w: 4, h: 12 },
    minSize: { w: 3, h: 8 },
    component: lazy(() => import("./NeuralWidget")),
  },
  {
    type: "music",
    title: "Music Player",
    description: "Now playing and controls. NETRUNNER tabs and music sites first; stays on its track when paused.",
    icon: Music,
    status: "live",
    dataSource:
      "NETRUNNER browser tabs and web overlays (read from the page's own player), then other apps through Windows media sessions (Spotify, Chrome…). Apps that publish no media session cannot be shown.",
    keywords: ["media", "audio", "spotify", "soundcloud", "now playing", "player"],
    defaultSize: { w: 4, h: 5 },
    minSize: { w: 3, h: 3 },
    settings: MUSIC_SETTINGS,
    component: lazy(() => import("./MusicWidget")),
  },
  {
    type: "activity",
    title: "Activity Log",
    description: "What NETRUNNER has done recently.",
    icon: Activity,
    status: "live",
    dataSource: "NETRUNNER's own activity log (local database).",
    keywords: ["log", "history", "events", "audit"],
    defaultSize: { w: 3, h: 10 },
    minSize: { w: 2, h: 4 },
    settings: ACTIVITY_SETTINGS,
    component: lazy(() => import("./ActivityWidget")),
  },
  {
    type: "clock",
    title: "Clock / Calendar",
    description: "Local time, date and month view.",
    icon: CalendarClock,
    status: "live",
    dataSource: "System clock.",
    keywords: ["time", "date", "calendar"],
    defaultSize: { w: 3, h: 5 },
    minSize: { w: 2, h: 3 },
    settings: CLOCK_SETTINGS,
    component: lazy(() => import("./ClockWidget")),
  },
  {
    type: "thermal",
    title: "Thermal Monitor",
    description: "Temperature sensors exposed by Windows.",
    icon: Thermometer,
    status: "live",
    dataSource:
      "ACPI thermal zones via sysinfo. Usually empty without elevation; Windows has no standard sensor API for CPU/fan readings. A bridge to tools like HWiNFO is a possible future integration.",
    keywords: ["temperature", "sensors", "fans", "heat"],
    defaultSize: { w: 4, h: 5 },
    minSize: { w: 3, h: 4 },
    component: lazy(() => import("./ThermalWidget")),
  },
  {
    type: "image",
    title: "Image",
    description: "A picture of your choice, just for looks.",
    icon: Image,
    status: "live",
    dataSource: "An image you added; NETRUNNER keeps its own copy (same library as backgrounds).",
    keywords: ["picture", "photo", "wallpaper", "art", "картинка", "decoration"],
    defaultSize: { w: 3, h: 6 },
    minSize: { w: 1, h: 2 },
    settings: IMAGE_SETTINGS,
    component: lazy(() => import("./ImageWidget")),
  },
];

/** Frame settings followed by the widget's own settings. */
export function widgetSchema(def: WidgetDef | undefined): WidgetSchema {
  return def?.settings ? [...FRAME_SETTINGS, ...def.settings] : FRAME_SETTINGS;
}

export function widgetConfig(def: WidgetDef | undefined, raw: RawConfig | undefined): RawConfig {
  return resolveConfig(widgetSchema(def), raw);
}

export const WIDGETS: Record<string, WidgetDef> = Object.fromEntries(defs.map((d) => [d.type, d]));
export const WIDGET_TYPES = defs.map((d) => d.type);
