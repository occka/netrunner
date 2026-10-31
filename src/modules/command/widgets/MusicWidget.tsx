import { useEffect, useMemo, useRef, useState } from "react";
import { Music, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { api } from "@/services/api";
import { reportError } from "@/stores/notifications";
import { Sampling } from "./common";
import { chooseSource, mergeSources, type MusicSource } from "./musicSources";
import type { WidgetProps } from "./registry";
import type { ConfigOf, MUSIC_SETTINGS } from "./settings";
import type { MediaStatus, TabMedia } from "@/types/browser";

const fmt = (secs: number | null) => {
  if (secs == null) return "--:--";
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Page artwork is fetched by the backend once per URL (the UI only shows inline images). */
const artCache = new Map<string, Promise<string | null>>();
function useArtwork(source: MusicSource | undefined) {
  const [art, setArt] = useState<string | null>(null);
  const url = source?.artworkUrl ?? null;
  useEffect(() => {
    if (!url) return setArt(null);
    let alive = true;
    if (!artCache.has(url)) artCache.set(url, api.browser.mediaArtwork(url).catch(() => null));
    void artCache.get(url)!.then((a) => alive && setArt(a));
    return () => {
      alive = false;
    };
  }, [url]);
  return source?.thumbnail ?? art;
}

export default function MusicWidget({ config: c }: WidgetProps<ConfigOf<typeof MUSIC_SETTINGS>>) {
  const [tabs, setTabs] = useState<TabMedia[] | null>(null);
  const [system, setSystem] = useState<MediaStatus | null>(null);
  // The source on screen and whether the user picked it; see musicSources.ts.
  const held = useRef<{ key: string | null; manual: boolean }>({ key: null, manual: false });
  const [, force] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      void Promise.all([api.browser.media().catch(() => []), api.media.status().catch(() => null)]).then(([t, s]) => {
        if (!alive) return;
        setTabs(t);
        setSystem(s);
        setTick(0);
      });
    };
    load();
    const poll = window.setInterval(load, 1500);
    const clock = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, []);

  const sources = useMemo(() => mergeSources(tabs ?? [], system?.sessions ?? [], c.sources), [tabs, system, c.sources]);
  const key = chooseSource(sources, held.current.key, held.current.manual, c.sources);
  if (key !== held.current.key) held.current = { key, manual: held.current.manual && key === held.current.key };
  const source = sources.find((s) => s.key === key);
  const art = useArtwork(source);

  if (!tabs && !system) return <Sampling />;
  if (!source)
    return (
      <div className="na-widget">
        <Music size={22} />
        <div className="label">Nothing is playing</div>
        <p>
          {c.sources === "netrunner-only"
            ? "Play music in a BROWSER tab or a web overlay."
            : "NETRUNNER tabs and overlays show here first, then apps with Windows media controls (Spotify, Chrome…)."}
        </p>
      </div>
    );

  const playing = source.playing;
  const pos = source.positionSecs != null ? Math.min(source.durationSecs ?? Infinity, source.positionSecs + (playing ? tick : 0)) : null;
  const control = (action: "toggle" | "next" | "previous") => {
    const done =
      source.kind === "tab"
        ? api.browser.mediaControl(source.target, action === "next" ? "nexttrack" : action === "previous" ? "previoustrack" : "toggle")
        : api.media.control(source.target, action);
    void done.catch((err) => reportError("Player did not respond", err));
    // Show the new state right away; the next poll confirms it.
    if (action === "toggle") setTabs((t) => t?.map((x) => (`tab:${x.tab}` === source.key ? { ...x, playing: !x.playing } : x)) ?? t);
  };

  return (
    <div className={`music music--${c.layout}`}>
      {c.art && <div className="music__art">{art ? <img src={art} alt="" /> : <Music size={26} strokeWidth={1.4} />}</div>}
      <div className="music__info">
        <div className="music__title truncate" title={source.title}>
          {source.title || "Unknown title"}
        </div>
        <div className="music__artist truncate muted">{[source.artist, source.album].filter(Boolean).join(" · ") || "—"}</div>
        {c.progress && source.durationSecs != null && (
          <div className="music__progress">
            <div className="meter">
              <div className="meter__fill" style={{ width: `${((pos ?? 0) / source.durationSecs) * 100}%` }} />
            </div>
            <span className="mono muted">
              {fmt(pos)} / {fmt(source.durationSecs)}
            </span>
          </div>
        )}
        <div className="music__controls">
          <button className="icon-btn" title="Previous" disabled={!source.canPrevious} onClick={() => control("previous")}>
            <SkipBack size={15} />
          </button>
          <button className="icon-btn music__play" title={playing ? "Pause" : "Play"} onClick={() => control("toggle")}>
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button className="icon-btn" title="Next" disabled={!source.canNext} onClick={() => control("next")}>
            <SkipForward size={15} />
          </button>
          {c.source &&
            (sources.length > 1 ? (
              <select
                className="input music__source"
                value={source.key}
                title="Player (your choice stays until it closes)"
                onChange={(e) => {
                  held.current = { key: e.target.value, manual: true };
                  force((n) => n + 1);
                }}
              >
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                    {s.playing ? " ▶" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="label music__source">{source.label}</span>
            ))}
        </div>
      </div>
    </div>
  );
}
