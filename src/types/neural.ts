/** NEURAL (Gemini) and FILES payload types. */

export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "selection"; label: string; text: string }
  | { kind: "tree"; root: string }
  | { kind: "image"; name: string; bytes: number };

export interface ContextItem {
  label: string;
  bytes: number;
  error: string | null;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  inputTokenLimit: number | null;
}

export interface NeuralStatus {
  configured: boolean;
  model: string;
  playModel: string;
}

export type NeuralMode = "work" | "play";

/** Something the agent did, shown as a card under its reply. */
export interface NeuralAction {
  kind: "write" | "append" | "edit" | "dice" | "python";
  label: string;
  detail: string | null;
  error: string | null;
  added: number;
  removed: number;
  change: number | null;
}

export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "model"; model: string; fallback: boolean }
  | { type: "delta"; text: string }
  | { type: "action"; action: NeuralAction }
  | { type: "context"; dropped: number }
  | { type: "done"; promptTokens: number | null; outputTokens: number | null; finishReason: string | null };

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: number | null;
  hidden: boolean;
}

export interface Places {
  drives: { path: string; label: string; totalBytes: number; freeBytes: number }[];
  places: [string, string][];
}

export type FilePreview =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "image"; dataUrl: string }
  | { kind: "archive"; listing: { entries: { name: string; size: number; isDir: boolean }[]; total: number; unpackedBytes: number; encrypted: boolean } }
  | { kind: "none"; reason: string };

export interface ChatState {
  activeId: number;
  chats: { id: number; title: string; updatedAt: string; messageCount: number }[];
  messages: { id: number; role: "user" | "model"; text: string; model: string | null; sent: string[]; images: string[]; actions: NeuralAction[] }[];
  mode: NeuralMode;
  kept: Attachment[];
}