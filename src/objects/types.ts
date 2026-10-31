/**
 * Universal object model. Modules expose their items as `NrObject`s so the
 * Inspector, command palette and (later) AI context share one representation.
 */
import type { LucideIcon } from "lucide-react";

export type ObjectType = "qa-entry" | "widget" | "module" | "profile";

/** A lightweight, serialisable pointer to an object. */
export type ObjectRef =
  | { type: "qa-entry"; id: number }
  | { type: "widget"; id: string }
  | { type: "module"; id: string }
  | { type: "profile"; id: number };

export interface ObjectAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  /** When set, the action is shown disabled with this explanation. */
  unavailable?: string;
  run: () => void | Promise<void>;
}

export interface ObjectDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface NrObject {
  ref: ObjectRef;
  /** Human-readable category, e.g. "Application", "Widget". */
  kindLabel: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  /** Short status chips shown in OVERVIEW. */
  tags?: { label: string; tone?: "ok" | "warn" | "crit" | "accent" | "info" }[];
  summary?: string;
  details: ObjectDetail[];
  actions: ObjectAction[];
}

export function refKey(ref: ObjectRef): string {
  return `${ref.type}:${ref.id}`;
}

export function sameRef(a: ObjectRef | null, b: ObjectRef | null): boolean {
  return !!a && !!b && a.type === b.type && a.id === b.id;
}
