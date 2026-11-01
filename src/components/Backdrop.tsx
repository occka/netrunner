import { useEffect, useState, type CSSProperties } from "react";
import { api } from "@/services/api";
import { backgroundActive, type BackgroundSpec } from "@/styles/appearance";
import { MatrixRain } from "./MatrixRain";

/** Wallpapers are read once per name and kept as data URLs for the session. */
const cache = new Map<string, Promise<string | null>>();
export function useWallpaper(name: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!name) return setUrl(null);
    let alive = true;
    if (!cache.has(name)) cache.set(name, api.appearance.wallpaperData(name).catch(() => null));
    void cache.get(name)!.then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [name]);
  return url;
}

export function forgetWallpaper(name: string) {
  cache.delete(name);
}

const FIT: Record<BackgroundSpec["fit"], CSSProperties> = {
  cover: { backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  contain: { backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  center: { backgroundSize: "auto", backgroundPosition: "center", backgroundRepeat: "no-repeat" },
  tile: { backgroundSize: "auto", backgroundPosition: "0 0", backgroundRepeat: "repeat" },
};

/**
 * Background layer: an image or a pattern, with dimming and blur. Rendered
 * behind the content of its positioned parent (`className` decides whether it
 * is fixed to the window or absolute in a module).
 */
export function Backdrop({ spec, className }: { spec: BackgroundSpec; className: string }) {
  const url = useWallpaper(spec.kind === "image" ? spec.image : null);
  if (!backgroundActive(spec)) return null;
  return (
    <div className={`backdrop ${className}`} aria-hidden>
      {spec.kind === "image" ? (
        url && (
          <div
            className="backdrop__image"
            style={{
              backgroundImage: `url("${url}")`,
              filter: spec.blur ? `blur(${spec.blur}px)` : undefined,
              // Blur bleeds transparent edges; scale slightly so they stay off-screen.
              transform: spec.blur ? `scale(${1 + spec.blur / 200})` : undefined,
              ...FIT[spec.fit],
            }}
          />
        )
      ) : (
        <div className={`backdrop__pattern backdrop__pattern--${spec.pattern}`}>{spec.pattern === "matrix" && <MatrixRain />}</div>
      )}
      <div className="backdrop__dim" style={{ opacity: spec.dim / 100 }} />
    </div>
  );
}
