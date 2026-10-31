/**
 * Builds `NrObject`s from object references using current store data.
 * Inspector and palette call these instead of each module inventing its own
 * object representation.
 */
import {
  ExternalLink,
  FolderOpen,
  Pencil,
  Play,
  Star,
  StarOff,
  Trash2,
  LayoutGrid,
  CheckCircle2,
  Code2,
} from "lucide-react";
import { MODULE_BY_ID, STATUS_LABEL, type ModuleId } from "@/app/modules";
import { useQuickAccess } from "@/stores/quickAccess";
import { useProfiles, PROFILE_KIND_LABEL } from "@/stores/profiles";
import { useShell } from "@/stores/shell";
import { useDashboard } from "@/stores/dashboard";
import { reportError } from "@/stores/notifications";
import { WIDGETS, WIDGET_STATUS_LABEL } from "@/modules/command/widgets/registry";
import { ENTRY_KIND_META, entryActionLabel, entryHasLocation, entryIcon } from "@/modules/quick-access/entryMeta";
import { formatRelative, parseDbTime } from "@/utils/format";
import type { NrObject, ObjectRef } from "@/objects/types";
import type { QuickAccessEntry } from "@/types/entities";

export function entryObject(entry: QuickAccessEntry): NrObject {
  const qa = useQuickAccess.getState();
  const meta = ENTRY_KIND_META[entry.kind];
  const details = [
    { label: "Type", value: meta.label },
    { label: entry.kind === "website" ? "URL" : entry.kind === "command" ? "Command" : "Target", value: entry.target, mono: true },
  ];
  if (entry.args) details.push({ label: "Arguments", value: entry.args, mono: true });
  if (entry.workingDir) details.push({ label: "Working dir", value: entry.workingDir, mono: true });
  if (entry.shell) details.push({ label: "Shell", value: entry.shell === "powershell" ? "PowerShell" : "Command Prompt" });
  if (entry.category) details.push({ label: "Category", value: entry.category });
  details.push(
    { label: "Launches", value: String(entry.launchCount) },
    { label: "Last launched", value: formatRelative(parseDbTime(entry.lastLaunchedAt)) },
    { label: "Added", value: parseDbTime(entry.createdAt)?.toLocaleString() ?? "—" },
  );

  const tags: NrObject["tags"] = [{ label: meta.label, tone: "info" }];
  if (entry.favorite) tags.push({ label: "Favorite", tone: "accent" });
  if (entry.kind === "command" && entry.requireConfirm) tags.push({ label: "Confirm to run", tone: "warn" });

  return {
    ref: { type: "qa-entry", id: entry.id },
    kindLabel: meta.label,
    title: entry.name,
    subtitle: entry.target,
    icon: entryIcon(entry),
    tags,
    details,
    actions: [
      ...(entry.kind === "project"
        ? [
            {
              id: "open-dev",
              label: "Open in Developer",
              icon: Code2,
              run: async () => {
                const { useDev } = await import("@/modules/developer/store");
                useShell.getState().navigate("developer");
                await useDev.getState().openProject(entry.target);
              },
            },
          ]
        : []),
      { id: "launch", label: entry.kind === "project" ? "Open folder" : entryActionLabel(entry), icon: Play, run: () => qa.launch(entry) },
      {
        id: "reveal",
        label: "Open location",
        icon: FolderOpen,
        unavailable: entryHasLocation(entry) ? undefined : "No file system location",
        run: () => qa.reveal(entry),
      },
      { id: "edit", label: "Edit", icon: Pencil, run: () => qa.openEditor(entry.id) },
      {
        id: "favorite",
        label: entry.favorite ? "Remove from favorites" : "Add to favorites",
        icon: entry.favorite ? StarOff : Star,
        run: () => qa.toggleFavorite(entry),
      },
      { id: "remove", label: "Remove", icon: Trash2, danger: true, run: () => qa.remove(entry) },
    ],
  };
}

function widgetObject(id: string): NrObject | null {
  const profiles = useProfiles.getState();
  const dash = useDashboard.getState();
  const layout = dash.draft ?? profiles.profiles.find((p) => p.id === profiles.activeId)?.layout;
  const instance = layout?.widgets.find((w) => w.id === id);
  if (!instance) return null;
  const def = WIDGETS[instance.type];
  return {
    ref: { type: "widget", id },
    kindLabel: "Widget",
    title: def?.title ?? instance.type,
    subtitle: def?.description,
    icon: def?.icon ?? LayoutGrid,
    tags: def ? [{ label: WIDGET_STATUS_LABEL[def.status], tone: def.status === "live" ? "ok" : "warn" }] : [],
    summary: def?.dataSource,
    details: [
      { label: "Instance", value: instance.id, mono: true },
      { label: "Position", value: `col ${instance.x + 1}, row ${instance.y + 1}`, mono: true },
      { label: "Size", value: `${instance.w} × ${instance.h}`, mono: true },
    ],
    actions: [
      {
        id: "edit-layout",
        label: dash.editing ? "Remove from layout" : "Edit layout",
        icon: dash.editing ? Trash2 : LayoutGrid,
        danger: dash.editing,
        run: () => {
          if (dash.editing) {
            dash.removeWidget(id);
            useShell.getState().select(null);
          } else if (layout && profiles.activeId != null) {
            useShell.getState().navigate("command");
            dash.begin(layout, profiles.activeId);
          }
        },
      },
    ],
  };
}

function moduleObject(id: string): NrObject | null {
  const def = MODULE_BY_ID[id as ModuleId];
  if (!def) return null;
  return {
    ref: { type: "module", id },
    kindLabel: "Module",
    title: def.label,
    subtitle: def.description,
    icon: def.icon,
    tags: [{ label: STATUS_LABEL[def.status], tone: def.status === "implemented" ? "ok" : def.status === "partial" ? "info" : "warn" }],
    details: [
      { label: "Status", value: STATUS_LABEL[def.status] },
      { label: "Phase", value: String(def.phase) },
    ],
    actions: [{ id: "open", label: "Open module", icon: ExternalLink, run: () => useShell.getState().navigate(def.id) }],
  };
}

function profileObject(id: number): NrObject | null {
  const store = useProfiles.getState();
  const profile = store.profiles.find((p) => p.id === id);
  if (!profile) return null;
  const isActive = store.activeId === id;
  return {
    ref: { type: "profile", id },
    kindLabel: "Profile",
    title: profile.name,
    subtitle: `${PROFILE_KIND_LABEL[profile.kind]} profile`,
    icon: MODULE_BY_ID.profiles.icon,
    tags: [
      ...(isActive ? [{ label: "Active", tone: "ok" as const }] : []),
      ...(profile.isBuiltin ? [{ label: "Built-in" }] : []),
    ],
    details: [
      { label: "Type", value: PROFILE_KIND_LABEL[profile.kind] },
      { label: "Widgets", value: String(profile.layout.widgets.length) },
      { label: "Updated", value: parseDbTime(profile.updatedAt)?.toLocaleString() ?? "—" },
    ],
    actions: [
      {
        id: "activate",
        label: isActive ? "Active profile" : "Switch to profile",
        icon: CheckCircle2,
        unavailable: isActive ? "Already active" : undefined,
        run: () => store.activate(id).catch((err) => reportError("Could not switch profile", err)),
      },
      { id: "manage", label: "Manage profiles", icon: Pencil, run: () => useShell.getState().navigate("profiles") },
    ],
  };
}

export function resolveObject(ref: ObjectRef): NrObject | null {
  switch (ref.type) {
    case "qa-entry": {
      const entry = useQuickAccess.getState().entries.find((e) => e.id === ref.id);
      return entry ? entryObject(entry) : null;
    }
    case "widget":
      return widgetObject(ref.id);
    case "module":
      return moduleObject(ref.id);
    case "profile":
      return profileObject(ref.id);
  }
}
