import { useEffect, useRef } from "react";

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:=*+-<>¦|";
const CELL = 16;
const FRAME_MS = 50;

/** Reduced motion from the app setting, or from Windows when the setting follows it. */
function reducedMotion() {
  const mode = document.documentElement.dataset.motion;
  return mode === "reduced" || (mode === "system" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * "Matrix rain" background in the theme's colours. Runs at ~20 fps, stops
 * while the window is hidden, and draws a single still frame with reduced motion.
 */
export function MatrixRain() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let drops: number[] = [];
    let colors = { fg: "#00ff66", bg: "#000000", head: "#ffffff" };
    const readColors = () => {
      const s = getComputedStyle(document.documentElement);
      colors = {
        fg: s.getPropertyValue("--c-primary").trim() || colors.fg,
        bg: s.getPropertyValue("--c-background").trim() || colors.bg,
        head: s.getPropertyValue("--c-text").trim() || colors.head,
      };
    };
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      const rows = canvas.clientHeight / CELL;
      drops = Array.from({ length: Math.ceil(canvas.clientWidth / CELL) }, () => Math.random() * rows);
    };
    const step = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Fading the previous frame leaves the trails.
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.font = `${CELL - 2}px "JetBrains Mono", Consolas, monospace`;
      for (let i = 0; i < drops.length; i++) {
        const y = drops[i] * CELL;
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        ctx.fillStyle = Math.random() < 0.06 ? colors.head : colors.fg;
        ctx.globalAlpha = 0.85;
        ctx.fillText(glyph, i * CELL, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        else drops[i] += 1;
      }
      ctx.globalAlpha = 1;
    };

    readColors();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    // Theme or motion changes show up as attribute/style changes on the root.
    const mo = new MutationObserver(() => {
      readColors();
      schedule();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-motion"] });

    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = 0;
      if (reducedMotion()) return;
      if (t - last >= FRAME_MS) {
        last = t;
        step();
      }
      raf = requestAnimationFrame(loop);
    };
    function schedule() {
      if (reducedMotion()) {
        // One still frame: run the rain for a while without showing the steps.
        resize();
        for (let i = 0; i < 60; i++) step();
        return;
      }
      if (!raf) raf = requestAnimationFrame(loop);
    }
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return <canvas ref={ref} />;
}
