/**
 * Module registry. Adding a module = one entry here plus its folder under
 * src/modules/. Components load lazily on first navigation.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  Activity,
  BrainCircuit,
  Cable,
  Cpu,
  Database,
  FolderTree,
  Gamepad2,
  GitBranch,
  Globe,
  Layers,
  LayoutDashboard,
  Rocket,
  Settings,
  SquareTerminal,
  UserCog,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type ModuleId =
  | "command"
  | "system"
  | "files"
  | "games"
  | "browser"
  | "developer"
  | "github"
  | "neural"
  | "network"
  | "quick-access"
  | "overlay"
  | "automation"
  | "integrations"
  | "storage"
  | "profiles"
  | "settings";

/** Honest implementation status, shown in the UI. */
export type ModuleStatus = "implemented" | "partial" | "planned";

export interface ModuleDef {
  id: ModuleId;
  label: string;
  icon: LucideIcon;
  status: ModuleStatus;
  phase: number;
  description: string;
  /** Capabilities planned for this module (shown on planned screens). */
  planned: string[];
  component?: LazyExoticComponent<ComponentType>;
  /** Navigation group: primary modules first, utility modules at the bottom. */
  group: "main" | "utility";
}

const Planned = lazy(() => import("@/modules/planned/PlannedModule"));

export const MODULES: ModuleDef[] = [
  {
    id: "command",
    label: "Command",
    icon: LayoutDashboard,
    status: "implemented",
    phase: 1,
    group: "main",
    description: "Main dashboard and central workspace.",
    planned: [],
    component: lazy(() => import("@/modules/command/CommandModule")),
  },
  {
    id: "quick-access",
    label: "Quick Access",
    icon: Rocket,
    status: "implemented",
    phase: 1,
    group: "main",
    description: "Universal launcher for applications, games, files, folders, websites, commands and projects.",
    planned: ["Automatic application discovery", "Executable icon extraction", "Per-profile entry sets"],
    component: lazy(() => import("@/modules/quick-access/QuickAccessModule")),
  },
  {
    id: "system",
    label: "System",
    icon: Cpu,
    status: "implemented",
    phase: 2,
    group: "main",
    description: "Windows and hardware monitoring.",
    planned: ["Audio devices and per-app volume", "Starting/stopping services (needs administrator)", "Fan and CPU temperature providers"],
    component: lazy(() => import("@/modules/system/SystemModule")),
  },
  {
    id: "files",
    label: "Files",
    icon: FolderTree,
    status: "partial",
    phase: 4,
    group: "main",
    description: "Advanced file manager.",
    planned: ["Archive browsing (zip/7z)", "Duplicate detection", "Opt-in indexing", "Thumbnail grid view"],
    component: lazy(() => import("@/modules/files/FilesModule")),
  },
  {
    id: "games",
    label: "Games",
    icon: Gamepad2,
    status: "implemented",
    phase: 2,
    group: "main",
    description: "Game library and launcher integrations.",
    planned: ["Per-game profiles and overlays", "More launchers (EA app, Ubisoft Connect, Battle.net)"],
    component: lazy(() => import("@/modules/games/GamesModule")),
  },
  {
    id: "developer",
    label: "Developer",
    icon: SquareTerminal,
    status: "partial",
    phase: 3,
    group: "main",
    description: "Integrated development environment built on Monaco.",
    planned: ["Language servers (LSP): completion, diagnostics, go-to-definition", "Debugger via Debug Adapter Protocol", "Formatter integration", "Gemini assistant (Phase 4)", "Extensions"],
    component: lazy(() => import("@/modules/developer/DeveloperModule")),
  },
  {
    id: "github",
    label: "GitHub",
    icon: GitBranch,
    status: "implemented",
    phase: 3,
    group: "main",
    description: "Repositories, branches, pull requests and issues.",
    planned: ["OAuth device-flow sign-in (needs a registered OAuth app)", "Creating / reviewing pull requests in-app", "Issue editing"],
    component: lazy(() => import("@/modules/github/GitHubModule")),
  },
  {
    id: "neural",
    label: "Neural",
    icon: BrainCircuit,
    status: "implemented",
    phase: 4,
    group: "main",
    description: "Gemini assistant. It only sees what you attach.",
    planned: ["Conversation history saved locally (opt-in)", "AI-assisted semantic search", "Image attachments"],
    component: lazy(() => import("@/modules/neural/NeuralModule")),
  },
  {
    id: "browser",
    label: "Browser",
    icon: Globe,
    status: "planned",
    phase: 5,
    group: "main",
    description: "WebView2 browser with tabs and bookmarks.",
    planned: ["Tabs", "Bookmarks", "History", "Downloads", "Web widgets"],
  },
  {
    id: "network",
    label: "Network",
    icon: Activity,
    status: "implemented",
    phase: 2,
    group: "main",
    description: "Network monitoring and VPN integrations.",
    planned: ["Per-process network usage", "VPN control through documented client CLIs"],
    component: lazy(() => import("@/modules/network/NetworkModule")),
  },
  {
    id: "overlay",
    label: "Overlay",
    icon: Layers,
    status: "partial",
    phase: 5,
    group: "main",
    description: "Independent always-on-top floating widgets.",
    planned: ["Widget Studio (BASIC / WEB / ADVANCED)", "Web overlays (SoundCloud, custom URL)", "Per-profile overlay sets"],
    component: lazy(() => import("@/modules/overlay/OverlayModule")),
  },
  {
    id: "automation",
    label: "Automation",
    icon: Workflow,
    status: "implemented",
    phase: 2,
    group: "main",
    description: "Event-driven automation engine.",
    planned: ["File created / download completed triggers", "Multiple actions per rule", "Visual node editor (Phase 5)"],
    component: lazy(() => import("@/modules/automation/AutomationModule")),
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Cable,
    status: "partial",
    phase: 2,
    group: "main",
    description: "External application integrations and plugins.",
    planned: ["Plugin architecture (Phase 5)", "User-defined integrations"],
    component: lazy(() => import("@/modules/integrations/IntegrationsModule")),
  },
  {
    id: "storage",
    label: "Storage",
    icon: Database,
    status: "partial",
    phase: 1,
    group: "utility",
    description: "Local application data.",
    planned: ["Export / import", "Manual backups", "Data reset with confirmation"],
    component: lazy(() => import("@/modules/storage/StorageModule")),
  },
  {
    id: "profiles",
    label: "Profiles",
    icon: UserCog,
    status: "implemented",
    phase: 1,
    group: "utility",
    description: "Workspace profiles.",
    planned: ["Per-profile Quick Access, overlays, hotkeys and automation"],
    component: lazy(() => import("@/modules/profiles/ProfilesModule")),
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    status: "implemented",
    phase: 1,
    group: "utility",
    description: "Application configuration.",
    planned: ["Start with Windows", "Minimise to tray", "Hotkey editor"],
    component: lazy(() => import("@/modules/settings/SettingsModule")),
  },
];

export const MODULE_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m])) as Record<ModuleId, ModuleDef>;

export function moduleComponent(def: ModuleDef) {
  return def.component ?? Planned;
}

export const STATUS_LABEL: Record<ModuleStatus, string> = {
  implemented: "Implemented",
  partial: "Partial",
  planned: "Planned",
};
