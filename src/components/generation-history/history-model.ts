import type { ApiSuite } from "../../api/client";
import type { Pipeline } from "../suite-studio/studio";

export type GenerationHistoryOrigin = "suite_studio" | "canvas" | "replica";

export interface GenerationHistoryFeedCard {
  taskId: string;
  previewUrl: string;
  title: string;
}

export interface GenerationHistoryFeedItem {
  suite: ApiSuite;
  pipeline: Pipeline | null;
  card: GenerationHistoryFeedCard | null;
  thumbnails?: string[];
  taskCount?: number;
}

export interface GenerationHistoryFeedPage {
  items: GenerationHistoryFeedItem[];
  total: number;
  limit: number;
  offset: number;
}

export type HistoryStatusTone = "running" | "paused" | "completed" | "failed" | "historical";

export interface HistoryStatusBadge {
  tone: HistoryStatusTone;
  label: string;
}

export interface FeedPaginationState {
  items: GenerationHistoryFeedItem[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export const GENERATION_HISTORY_PAGE_SIZE = 20;

export function buildFeedUrl(params: {
  origin: GenerationHistoryOrigin;
  keyword?: string;
  limit?: number;
  offset?: number;
}): string {
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? GENERATION_HISTORY_PAGE_SIZE)));
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const keyword = (params.keyword ?? "").trim();
  const query = new URLSearchParams();
  query.set("origin", params.origin);
  query.set("keyword", keyword);
  query.set("limit", String(limit));
  query.set("offset", String(offset));
  return `/api/suites/feed?${query.toString()}`;
}

export function extractThumbnails(item: GenerationHistoryFeedItem, maxCount = 4): string[] {
  const cap = Math.max(0, Math.floor(maxCount));
  if (cap === 0) return [];
  if (Array.isArray(item.thumbnails)) {
    return item.thumbnails
      .filter((url): url is string => typeof url === "string" && url.trim().length > 0)
      .slice(0, cap);
  }
  if (item.card?.previewUrl && item.card.previewUrl.trim().length > 0) {
    return [item.card.previewUrl];
  }
  return [];
}

export function resolveCardCount(item: GenerationHistoryFeedItem): number {
  if (typeof item.taskCount === "number" && Number.isFinite(item.taskCount) && item.taskCount >= 0) {
    return Math.floor(item.taskCount);
  }
  if (typeof item.suite.taskCount === "number" && Number.isFinite(item.suite.taskCount) && item.suite.taskCount >= 0) {
    return Math.floor(item.suite.taskCount);
  }
  return extractThumbnails(item).length;
}

export function resolveItemStatus(item: GenerationHistoryFeedItem): HistoryStatusBadge {
  const status = item.pipeline?.status;
  switch (status) {
    case "running":
      return { tone: "running", label: "运行中" };
    case "waiting_human_input":
    case "waiting_base_refine_decision":
      return { tone: "paused", label: "暂停" };
    case "completed":
      return { tone: "completed", label: "完成" };
    case "partial_failed":
      return { tone: "failed", label: "部分失败" };
    case "failed":
      return { tone: "failed", label: "失败" };
    default:
      return resolveCardCount(item) > 0
        ? { tone: "completed", label: "完成" }
        : { tone: "historical", label: "历史" };
  }
}

export function mergeFeedPages(
  existing: readonly GenerationHistoryFeedItem[],
  page: GenerationHistoryFeedPage,
  reset: boolean,
): FeedPaginationState {
  const incoming = Array.isArray(page.items) ? page.items : [];
  const total = typeof page.total === "number" && Number.isFinite(page.total) && page.total >= 0 ? page.total : incoming.length;
  const seen = new Set<string>();
  const items: GenerationHistoryFeedItem[] = [];

  if (!reset) {
    for (const item of existing) {
      if (!seen.has(item.suite.id)) {
        seen.add(item.suite.id);
        items.push(item);
      }
    }
  }

  for (const item of incoming) {
    if (!seen.has(item.suite.id)) {
      seen.add(item.suite.id);
      items.push(item);
    }
  }

  const baseOffset = reset
    ? 0
    : typeof page.offset === "number" && Number.isFinite(page.offset) && page.offset >= 0
      ? page.offset
      : existing.length;
  const nextOffset = baseOffset + incoming.length;
  const hasMore = incoming.length > 0 && nextOffset < total;

  return {
    items,
    total,
    offset: nextOffset,
    hasMore,
  };
}

export function formatHistoryTime(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  if (date.getFullYear() === now.getFullYear()) {
    return `${mm}-${dd} ${hh}:${min}`;
  }
  return `${date.getFullYear()}-${mm}-${dd} ${hh}:${min}`;
}
