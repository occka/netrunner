import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { ObjectAction } from "@/objects/types";

interface MenuState {
  menu: { x: number; y: number; actions: ObjectAction[] } | null;
  open: (x: number, y: number, actions: ObjectAction[]) => void;
  close: () => void;
}

export const useContextMenu = create<MenuState>((set) => ({
  menu: null,
  open: (x, y, actions) => set({ menu: { x, y, actions } }),
  close: () => set({ menu: null }),
}));

/** Global context menu host; actions come from the shared object model. */
export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu);
  const close = useContextMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.min(menu.y, window.innerHeight - height - 8),
    });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {menu.actions.map((a, i) => (
        <div key={a.id}>
          {a.danger && i > 0 && <div className="menu__sep" />}
          <button
            role="menuitem"
            className={`menu__item${a.danger ? " menu__item--danger" : ""}`}
            disabled={!!a.unavailable}
            title={a.unavailable}
            onClick={() => {
              close();
              void a.run();
            }}
          >
            {a.icon && <a.icon size={14} />}
            {a.label}
          </button>
        </div>
      ))}
    </div>
  );
}
