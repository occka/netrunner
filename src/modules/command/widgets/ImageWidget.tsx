import { ImageOff, ImagePlus } from "lucide-react";
import { useWallpaper } from "@/components/Backdrop";
import { useShell } from "@/stores/shell";
import type { WidgetProps } from "./registry";
import type { ConfigOf, IMAGE_SETTINGS } from "./settings";

/** A decorative picture from the image library. */
export default function ImageWidget({ instanceId, config: c, host }: WidgetProps<ConfigOf<typeof IMAGE_SETTINGS>>) {
  const url = useWallpaper(c.image || null);

  if (!c.image)
    return (
      <div className="na-widget">
        <ImagePlus size={22} />
        <div className="label">No picture yet</div>
        {host === "dashboard" ? (
          <button className="btn btn--sm" onClick={() => useShell.getState().inspect({ type: "widget", id: instanceId }, "settings")}>
            Choose a picture
          </button>
        ) : (
          <p>Pick one in OVERLAY → widget settings.</p>
        )}
      </div>
    );

  return (
    <figure className={`imgw${c.bleed ? " imgw--bleed" : ""}`}>
      {url ? (
        <img src={url} alt={c.caption} style={{ objectFit: c.fit, objectPosition: c.position, opacity: c.opacity / 100 }} />
      ) : (
        <div className="na-widget">
          <ImageOff size={20} />
          <p>Loading, or the picture was deleted from the library.</p>
        </div>
      )}
      {c.caption && <figcaption className="imgw__caption">{c.caption}</figcaption>}
    </figure>
  );
}
