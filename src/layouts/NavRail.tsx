import { useRef, useState, type KeyboardEvent } from "react";
import { Pin, PinOff } from "lucide-react";
import { MODULES, type ModuleDef } from "@/app/modules";
import { useShell } from "@/stores/shell";
import { useSetting, useSettings } from "@/stores/settings";
import { reportError } from "@/stores/notifications";

const HOVER_DELAY_MS = 200;

export function NavRail() {
  const active = useShell((s) => s.module);
  const navigate = useShell((s) => s.navigate);
  const pinned = useSetting("nav.pinned");
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number>();
  const listRef = useRef<HTMLDivElement>(null);
  const open = pinned || hovered;

  const onEnter = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(true), HOVER_DELAY_MS);
  };
  const onLeave = () => {
    window.clearTimeout(timer.current);
    setHovered(false);
  };

  // Arrow keys move focus between items (roving focus within the rail).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.nav__item") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  };

  const togglePin = () => {
    setHovered(false);
    useSettings
      .getState()
      .set("nav.pinned", !pinned)
      .catch((err) => reportError("Could not save navigation state", err));
  };

  const item = (m: ModuleDef) => (
    <button
      key={m.id}
      className="nav__item"
      aria-current={active === m.id ? "page" : undefined}
      onClick={() => navigate(m.id)}
      title={open ? undefined : m.label}
      data-status={m.status}
    >
      <m.icon size={17} strokeWidth={1.6} />
      <span className="nav__label">{m.label}</span>
      {m.status === "planned" && <span className="nav__phase">P{m.phase}</span>}
    </button>
  );

  return (
    <div className="shell__nav" data-pinned={pinned}>
      <nav
        className="nav"
        data-open={open}
        aria-label="Modules"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={() => setHovered(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHovered(false)}
      >
        <div className="nav__list" ref={listRef} onKeyDown={onKeyDown}>
          {MODULES.filter((m) => m.group === "main").map(item)}
          <div className="nav__sep" />
          {MODULES.filter((m) => m.group === "utility").map(item)}
        </div>
        <button className="nav__pin" onClick={togglePin} aria-pressed={pinned} title={pinned ? "Unpin" : "Pin open"}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          <span className="nav__label">{pinned ? "Collapse" : "Pin expanded"}</span>
        </button>
      </nav>
    </div>
  );
}
