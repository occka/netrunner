// Stops media from starting by itself on sites the user chose, until the user has
// clicked or pressed a key on the page. WebView2 has only a global autoplay policy,
// so this runs in the page. `navigator.userActivation` cannot decide it: a page
// opened by NETRUNNER starts out activated. SITES is filled in by the backend.
(() => {
  const host = location.hostname;
  if (!SITES.some((s) => host === s || host.endsWith("." + s))) return;
  let allowed = false;
  for (const type of ["pointerdown", "keydown"]) {
    addEventListener(
      type,
      (e) => {
        if (e.isTrusted) allowed = true;
      },
      true,
    );
  }
  HTMLMediaElement.prototype.play = new Proxy(HTMLMediaElement.prototype.play, {
    apply(target, self, args) {
      if (allowed) return Reflect.apply(target, self, args);
      return Promise.reject(new DOMException("Blocked: this site may not start media by itself", "NotAllowedError"));
    },
  });
  // The `autoplay` attribute starts playback without calling play().
  addEventListener(
    "play",
    (e) => {
      if (!allowed && e.target instanceof HTMLMediaElement) e.target.pause();
    },
    true,
  );
})();
