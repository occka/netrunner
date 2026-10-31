// NETRUNNER media hook (top frame of browser tabs and web overlays).
// Records what the page plays and the Media Session handlers it registers,
// so the Music Player widget can show and control this tab. It exposes data
// only to NETRUNNER through Webview::eval; nothing is sent anywhere.
(() => {
  if (window.top !== window || window.__nrMedia) return;
  const elements = new Set();
  const handlers = {};
  let metadata = null;
  let sessionState = "none";
  const ms = navigator.mediaSession;
  try {
    if (ms) {
      const set = ms.setActionHandler.bind(ms);
      ms.setActionHandler = (action, handler) => {
        handlers[action] = handler;
        return set(action, handler);
      };
      const meta = Object.getOwnPropertyDescriptor(MediaSession.prototype, "metadata");
      if (meta && meta.set)
        Object.defineProperty(ms, "metadata", {
          configurable: true,
          get: () => meta.get.call(ms),
          set: (v) => {
            metadata = v;
            meta.set.call(ms, v);
          },
        });
      const ps = Object.getOwnPropertyDescriptor(MediaSession.prototype, "playbackState");
      if (ps && ps.set)
        Object.defineProperty(ms, "playbackState", {
          configurable: true,
          get: () => ps.get.call(ms),
          set: (v) => {
            sessionState = v;
            ps.set.call(ms, v);
          },
        });
    }
  } catch (e) {}
  const track = (el) => {
    if (elements.size > 24) for (const old of elements) if (old.paused && !old.isConnected) elements.delete(old);
    elements.add(el);
  };
  // Players often use detached `new Audio()` elements, so patch play() too.
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    track(this);
    return play.apply(this, arguments);
  };
  document.addEventListener("play", (e) => e.target instanceof HTMLMediaElement && track(e.target), true);
  const current = () => {
    let fallback = null;
    for (const el of elements) {
      if (!el.paused) return el;
      if (el.currentSrc || el.srcObject) fallback = el;
    }
    return fallback;
  };
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  Object.defineProperty(window, "__nrMedia", {
    value: Object.freeze({
      state() {
        const m = metadata || (ms && ms.metadata);
        const el = current();
        return JSON.stringify({
          title: m ? String(m.title || "") : "",
          artist: m ? String(m.artist || "") : "",
          album: m ? String(m.album || "") : "",
          artwork: m && m.artwork ? Array.from(m.artwork).slice(0, 8).map((a) => ({ src: String(a.src || ""), sizes: String(a.sizes || "") })) : [],
          playing: el ? !el.paused : sessionState === "playing",
          present: !!el || !!m,
          position: el ? num(el.currentTime) : null,
          duration: el ? num(el.duration) : null,
          actions: Object.keys(handlers).filter((k) => typeof handlers[k] === "function"),
          docTitle: document.title,
        });
      },
      act(action) {
        const el = current();
        if (action === "toggle") action = (el ? !el.paused : sessionState === "playing") ? "pause" : "play";
        const handler = handlers[action];
        if (typeof handler === "function") {
          try {
            handler({ action });
            return "handler";
          } catch (e) {}
        }
        if (el && action === "play") return el.play().catch(() => {}), "element";
        if (el && action === "pause") return el.pause(), "element";
        return "none";
      },
    }),
  });
})();
