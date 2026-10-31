/**
 * Builds palette items from live application state and maps a chosen item to
 * its action. Each source corresponds to one object type.
 */
import { MODULES, MODULE_BY_ID, type ModuleId } from "@/app/modules";
import { useQuickAccess } from "@/stores/quickAccess";
import { useProfiles } from "@/stores/profiles";
import { useShell } from "@/stores/shell";
import { useDashboard, newWidgetId, nextFreeY } from "@/stores/dashboard";
import { useSettings } from "@/stores/settings";
import { notify, reportError } from "@/stores/notifications";
import { WIDGETS, WIDGET_TYPES } from "@/modules/command/widgets/registry";
import { SETTINGS_SECTIONS } from "@/modules/settings/settingsIndex";
import type { SearchCategory, SearchItem } from "@/search/query";
import type { EntryKind } from "@/types/entities";

const KIND_TO_CATEGORY: Record<EntryKind, SearchCategory> = {
  app: "app",
  game: "game",
  file: "file",
  folder: "folder",
  website: "web",
  command: "cmd",
  project: "project",
};

const ACTIONS: { id: string; title: string; keywords: string[]; run: () => void }[] = [
  {
    id: "add-object",
    title: "Add Quick Access object",
    keywords: ["new", "launcher", "shortcut", "create"],
    run: () => useQuickAccess.getState().openEditor(null),
  },
  {
    id: "edit-layout",
    title: "Edit dashboard layout",
    keywords: ["widgets", "arrange", "customize", "dashboard"],
    run: () => startEditing(),
  },
  {
    id: "toggle-inspector",
    title: "Toggle inspector",
    keywords: ["panel", "sidebar", "details"],
    run: () => {
      const s = useSettings.getState();
      s.set("inspector.visible", !s.values["inspector.visible"]).catch((e) => reportError("Could not save", e));
    },
  },
  {
    id: "toggle-nav",
    title: "Pin / unpin navigation",
    keywords: ["sidebar", "menu", "expand"],
    run: () => {
      const s = useSettings.getState();
      s.set("nav.pinned", !s.values["nav.pinned"]).catch((e) => reportError("Could not save", e));
    },
  },
];

function activeLayout() {
  const p = useProfiles.getState();
  return p.profiles.find((x) => x.id === p.activeId)?.layout;
}

function startEditing() {
  useShell.getState().navigate("command");
  const dash = useDashboard.getState();
  const layout = activeLayout();
  const profileId = useProfiles.getState().activeId;
  if (!dash.editing && layout && profileId != null) dash.begin(layout, profileId);
}

export function buildItems(): SearchItem[] {
  const items: SearchItem[] = [];
  for (const e of useQuickAccess.getState().entries) {
    items.push({
      id: `qa:${e.id}`,
      category: KIND_TO_CATEGORY[e.kind],
      title: e.name,
      subtitle: e.target,
      keywords: [e.category, e.kind].filter(Boolean),
    });
  }
  for (const m of MODULES) {
    items.push({ id: `module:${m.id}`, category: "module", title: m.label, subtitle: m.description });
  }
  for (const type of WIDGET_TYPES) {
    const w = WIDGETS[type];
    items.push({ id: `widget:${type}`, category: "widget", title: w.title, subtitle: w.description, keywords: w.keywords });
  }
  for (const s of SETTINGS_SECTIONS) {
    items.push({ id: `setting:${s.id}`, category: "setting", title: s.title, keywords: [...s.keywords] });
  }
  const profiles = useProfiles.getState();
  for (const p of profiles.profiles) {
    items.push({
      id: `profile:${p.id}`,
      category: "profile",
      title: p.name,
      subtitle: p.id === profiles.activeId ? "Active profile" : "Switch profile",
    });
  }
  for (const a of ACTIONS) {
    items.push({ id: `action:${a.id}`, category: "action", title: a.title, keywords: a.keywords });
  }
  return items;
}

export function runItem(item: SearchItem) {
  const [type, rawId] = [item.id.slice(0, item.id.indexOf(":")), item.id.slice(item.id.indexOf(":") + 1)];
  const shell = useShell.getState();
  switch (type) {
    case "qa": {
      const entry = useQuickAccess.getState().entries.find((e) => e.id === Number(rawId));
      if (entry) {
        shell.select({ type: "qa-entry", id: entry.id });
        void useQuickAccess.getState().launch(entry);
      }
      break;
    }
    case "module":
      shell.navigate(rawId as ModuleId);
      shell.select({ type: "module", id: rawId });
      break;
    case "widget": {
      const dash = useDashboard.getState();
      const layout = dash.draft ?? activeLayout();
      const existing = layout?.widgets.find((w) => w.type === rawId);
      shell.navigate("command");
      if (existing) {
        shell.select({ type: "widget", id: existing.id });
      } else if (layout) {
        startEditing();
        const def = WIDGETS[rawId];
        const draft = useDashboard.getState().draft;
        if (!draft || def.status === "planned") {
          notify.info(`${def.title} is planned`, def.dataSource);
          break;
        }
        const id = newWidgetId(rawId, draft.widgets);
        useDashboard.getState().addWidget({
          id,
          type: rawId,
          x: 0,
          y: nextFreeY(draft.widgets),
          w: def.defaultSize.w,
          h: def.defaultSize.h,
        });
        notify.info(`${def.title} added`, "Save the layout to keep it.");
      }
      break;
    }
    case "setting":
      shell.navigate("settings", rawId);
      break;
    case "profile":
      useProfiles
        .getState()
        .activate(Number(rawId))
        .then(() => notify.success(`Profile: ${item.title}`))
        .catch((err) => reportError("Could not switch profile", err));
      break;
    case "action":
      ACTIONS.find((a) => a.id === rawId)?.run();
      break;
  }
}

export function itemIcon(item: SearchItem) {
  const [type, rawId] = [item.id.slice(0, item.id.indexOf(":")), item.id.slice(item.id.indexOf(":") + 1)];
  if (type === "module") return MODULE_BY_ID[rawId as ModuleId]?.icon;
  if (type === "widget") return WIDGETS[rawId]?.icon;
  return undefined;
}
