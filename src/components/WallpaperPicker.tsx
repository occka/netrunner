import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ImagePlus, Trash2 } from "lucide-react";
import { api } from "@/services/api";
import { usePolled } from "@/hooks/usePolled";
import { useSettings } from "@/stores/settings";
import { confirmAction } from "@/stores/confirm";
import { reportError } from "@/stores/notifications";
import { forgetWallpaper, useWallpaper } from "@/components/Backdrop";

function Thumb({ name, selected, onPick, onDelete }: { name: string; selected: boolean; onPick: () => void; onDelete: () => void }) {
  const url = useWallpaper(name);
  return (
    <button
      className="wallpaper"
      aria-pressed={selected}
      title={name}
      style={url ? { backgroundImage: `url("${url}")` } : undefined}
      onClick={onPick}
    >
      <span
        className="icon-btn icon-btn--sm wallpaper__del"
        role="button"
        title="Delete this image"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 size={12} />
      </span>
    </button>
  );
}

/**
 * NETRUNNER's image library (backgrounds and Image widgets share it): pick an
 * image, add one from disk (it is copied in), or delete one.
 */
export function WallpaperPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const { data: images, reload } = usePolled(() => api.appearance.wallpapers());
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const path = await openDialog({
      title: "Choose an image",
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const wp = await api.appearance.importWallpaper(path);
      await reload();
      onChange(wp.name);
    } catch (err) {
      reportError("Could not add the image", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!(await confirmAction({ title: "Delete image", message: "Delete this image from NETRUNNER? The original file is not touched.", confirmLabel: "Delete", danger: true })))
      return;
    try {
      await api.appearance.deleteWallpaper(name);
      forgetWallpaper(name);
      // Backgrounds still pointing at it fall back to the theme colour.
      for (const key of ["appearance.background", "appearance.dashboard_background"] as const) {
        const s = useSettings.getState().values[key];
        if (s.image === name) await useSettings.getState().set(key, { ...s, kind: "none", image: "" });
      }
      if (value === name) onChange("");
      await reload();
    } catch (err) {
      reportError("Could not delete the image", err);
    }
  };

  return (
    <div className="wallpapers">
      {images?.map((w) => (
        <Thumb key={w.name} name={w.name} selected={value === w.name} onPick={() => onChange(w.name)} onDelete={() => void remove(w.name)} />
      ))}
      <button className="wallpaper wallpaper--add" disabled={busy} onClick={() => void add()} title="PNG, JPEG, WebP, GIF, BMP or AVIF up to 20 MB">
        <span>
          <ImagePlus size={18} /> {busy ? "Adding…" : "Add image"}
        </span>
      </button>
    </div>
  );
}
