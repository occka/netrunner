/** Widget Studio (services/studio.rs). */
export type StudioKind = "html" | "text" | "counter" | "links" | "feed";

export interface CustomWidget {
  id: number;
  /** Profile it belongs to; null = every profile. */
  profileId: number | null;
  name: string;
  kind: StudioKind;
  /** Kind-specific content, see StudioEditor. */
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface FeedItem {
  title: string;
  link: string | null;
  date: number | null;
  summary: string;
}

export interface FeedResult {
  items: FeedItem[];
  fetchedAt: number;
}
