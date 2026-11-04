// Removes ads on YouTube. Filter lists cannot do this alone: the ads arrive inside
// the same responses as the video, from the same servers. Runs before the page's
// scripts. Our own code, nothing downloaded; it only touches youtube.com pages.
(() => {
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) return;
  const stats = { pruned: 0, skipped: 0, dialogs: 0 };
  try {
    Object.defineProperty(window, Symbol.for("netrunner.youtube"), { value: stats });
  } catch (e) {
    return;
  }

  // 1. Ad data in player responses: without it, the player has no ads to schedule.
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];
  const hasAds = (text) => AD_KEYS.some((k) => text.includes(k));
  const prune = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 3) return o;
    for (const key of AD_KEYS) {
      if (key in o) {
        delete o[key];
        stats.pruned++;
      }
    }
    for (const key of ["playerResponse", "response"]) {
      if (o[key] && typeof o[key] === "object") prune(o[key], depth + 1);
    }
    if (Array.isArray(o)) o.slice(0, 8).forEach((x) => prune(x, depth + 1));
    return o;
  };

  // A Proxy keeps the original's name and `toString`, which pages may check.
  JSON.parse = new Proxy(JSON.parse, {
    apply(target, self, args) {
      const value = Reflect.apply(target, self, args);
      return typeof args[0] === "string" && hasAds(args[0]) ? prune(value) : value;
    },
  });

  const isPlayerApi = (r) => typeof r.url === "string" && r.url.includes("/youtubei/v1/");
  Response.prototype.json = new Proxy(Response.prototype.json, {
    apply(target, self, args) {
      const result = Reflect.apply(target, self, args);
      return isPlayerApi(self) ? result.then((v) => prune(v)) : result;
    },
  });
  Response.prototype.text = new Proxy(Response.prototype.text, {
    apply(target, self, args) {
      const result = Reflect.apply(target, self, args);
      if (!isPlayerApi(self)) return result;
      return result.then((text) => {
        if (!hasAds(text)) return text;
        try {
          return JSON.stringify(prune(JSON.parse(text)));
        } catch (e) {
          return text;
        }
      });
    },
  });

  // The first response is written into the page as a global variable.
  for (const name of ["ytInitialPlayerResponse", "ytPlayerResponse"]) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (v) => {
          value = prune(v);
        },
      });
    } catch (e) {}
  }

  // 2. Ad blocks in the page.
  const CSS =
    "ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer," +
    "ytd-display-ad-renderer,ytd-banner-promo-renderer,ytd-statement-banner-renderer,ytd-player-legacy-desktop-watch-ads-renderer," +
    "ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),ytd-rich-section-renderer:has(ytd-statement-banner-renderer)," +
    "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-ads']," +
    "#masthead-ad,#player-ads,.ytp-ad-overlay-container,.ytp-ad-image-overlay,.ytd-merch-shelf-renderer,ytd-merch-shelf-renderer" +
    "{display:none!important}";

  const addStyle = () => {
    if (document.adoptedStyleSheets === undefined || !window.CSSStyleSheet) return;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  };
  try {
    addStyle();
  } catch (e) {}

  // 3. An ad that still reaches the player (some are stitched into the video
  // stream): silent, at top speed, to its end, and skipped as soon as possible.
  let saved = null;
  const tick = () => {
    const player = document.querySelector(".html5-video-player");
    const video = player && player.querySelector("video");
    if (!video) return;
    if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) {
      if (!saved) {
        saved = { muted: video.muted, rate: video.playbackRate };
        stats.skipped++;
      }
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) video.currentTime = video.duration - 0.1;
      const skip = document.querySelector(".ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern");
      if (skip) skip.click();
    } else if (saved) {
      video.muted = saved.muted;
      video.playbackRate = saved.rate;
      saved = null;
    }

    // 4. The "ad blockers are not allowed" dialog pauses the video: close it and resume.
    const notice = document.querySelector("ytd-enforcement-message-view-model");
    if (notice) {
      const dialog = notice.closest("tp-yt-paper-dialog");
      if (dialog) dialog.remove();
      else notice.remove();
      document.querySelectorAll("tp-yt-iron-overlay-backdrop").forEach((b) => b.remove());
      stats.dialogs++;
      if (video.paused) video.play().catch(() => {});
    }
  };
  setInterval(tick, 300);
})();
