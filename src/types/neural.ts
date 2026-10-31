/** NEURAL (Gemini) and FILES payload types. */

export type Attachment =
  | { kind: "file"; path: string }
  | { kind: "selection"; label: string; text: string }
  | { kind: "tree"; root: string };

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
}

export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "model"; model: string; fallback: boolean }
  | { type: "delta"; text: string }
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
  | { kind: "none"; reason: string };

export interface ChatState {
  activeId: number;
  chats: { id: number; title: string; updatedAt: string; messageCount: number }[];
  messages: { id: number; role: "user" | "model"; text: string; model: string | null; sent: string[] }[];
}