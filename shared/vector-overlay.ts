import { SELLING_POINT_LAYOUTS, type SellingPointLayout } from "./selling-point-layouts.js";

export type VectorOverlayThemeId = "dark_tech" | "minimal_light" | "vibrant_promo" | "natural_warm";
export type VectorOverlayAlign = "left" | "center" | "right";
export type VectorOverlayLayoutId = SellingPointLayout["id"] | "custom";
export type VectorOverlayElementType = "text" | "pill" | "callout" | "card";
export type VectorOverlayPillIcon = "spark" | "shield" | "bolt" | "leaf" | "check" | "dot";

export interface VectorOverlayTheme {
  id: VectorOverlayThemeId;
  name: string;
  description: string;
  accentColor: string;
  textColor: string;
  subtextColor: string;
  bgColor: string;
  cardBgColor: string;
  pillBgColor: string;
  pillTextColor: string;
  borderColor: string;
  lineColor: string;
}

export const VECTOR_OVERLAY_THEMES: Record<VectorOverlayThemeId, VectorOverlayTheme> = {
  dark_tech: {
    id: "dark_tech",
    name: "深空科技",
    description: "深邃蓝黑底框搭配冰蓝高光，突出专业硬件与参数感",
    accentColor: "#38BDF8",
    textColor: "#F8FAFC",
    subtextColor: "#CBD5E1",
    bgColor: "#0F172AE6",
    cardBgColor: "#1E293BE8",
    pillBgColor: "#0284C7EB",
    pillTextColor: "#FFFFFF",
    borderColor: "#38BDF880",
    lineColor: "#38BDF8",
  },
  minimal_light: {
    id: "minimal_light",
    name: "极简亮白",
    description: "通透磨砂白底与利落炭黑字阶，适配家居个护高级视觉",
    accentColor: "#0F172A",
    textColor: "#0F172A",
    subtextColor: "#475569",
    bgColor: "#FFFFFFEB",
    cardBgColor: "#FFFFFFF2",
    pillBgColor: "#0F172AEB",
    pillTextColor: "#FFFFFF",
    borderColor: "#CBD5E1",
    lineColor: "#0F172A",
  },
  vibrant_promo: {
    id: "vibrant_promo",
    name: "活力暖橙",
    description: "高转化暖橙撞色配奶油白卡，强化核心卖点与点击吸引力",
    accentColor: "#EA580C",
    textColor: "#1C1917",
    subtextColor: "#57534E",
    bgColor: "#FFFBEBF2",
    cardBgColor: "#FFFFFFF2",
    pillBgColor: "#EA580CEB",
    pillTextColor: "#FFFFFF",
    borderColor: "#FDBA74",
    lineColor: "#EA580C",
  },
  natural_warm: {
    id: "natural_warm",
    name: "自然森系",
    description: "温润森系深绿与米白暖卡，适合母婴、食品与天然材质",
    accentColor: "#15803D",
    textColor: "#14532D",
    subtextColor: "#4B5563",
    bgColor: "#FAF7F2F2",
    cardBgColor: "#FFFFFFEE",
    pillBgColor: "#15803DEB",
    pillTextColor: "#FFFFFF",
    borderColor: "#86EFAC",
    lineColor: "#15803D",
  },
};

export const VECTOR_OVERLAY_THEME_LIST: VectorOverlayTheme[] = Object.values(VECTOR_OVERLAY_THEMES);

export interface VectorOverlayBaseElement {
  id: string;
  type: VectorOverlayElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
  align: VectorOverlayAlign;
}

export interface VectorOverlayTextElement extends VectorOverlayBaseElement {
  type: "text";
  subtext?: string;
  fontWeight?: number;
  bgColor?: string;
}

export interface VectorOverlayPillElement extends VectorOverlayBaseElement {
  type: "pill";
  icon?: VectorOverlayPillIcon | string;
  bgColor: string;
  borderColor?: string;
}

export interface VectorOverlayCalloutElement extends VectorOverlayBaseElement {
  type: "callout";
  anchorX: number;
  anchorY: number;
  subtext?: string;
  bgColor: string;
  lineColor: string;
}

export interface VectorOverlayCardElement extends VectorOverlayBaseElement {
  type: "card";
  subtext?: string;
  bgColor: string;
  borderColor?: string;
}

export type VectorOverlayElement =
  | VectorOverlayTextElement
  | VectorOverlayPillElement
  | VectorOverlayCalloutElement
  | VectorOverlayCardElement;

export interface VectorOverlayDocument {
  version: 1;
  layoutId: VectorOverlayLayoutId;
  themeId: VectorOverlayThemeId;
  elements: VectorOverlayElement[];
}

export interface VectorOverlaySeed {
  headline?: string;
  subhead?: string;
  points?: string[];
  themeId?: VectorOverlayThemeId;
}

const VALID_LAYOUT_IDS = new Set<string>([...SELLING_POINT_LAYOUTS.map((item) => item.id), "custom"]);
const VALID_THEME_IDS = new Set<string>(Object.keys(VECTOR_OVERLAY_THEMES));
const VALID_ALIGNS = new Set<string>(["left", "center", "right"]);
const VALID_TYPES = new Set<string>(["text", "pill", "callout", "card"]);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`VECTOR_OVERLAY_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAlign(value: unknown): VectorOverlayAlign {
  if (value === undefined) return "left";
  if (typeof value === "string" && VALID_ALIGNS.has(value)) return value as VectorOverlayAlign;
  throw new Error("VECTOR_OVERLAY_INVALID_ALIGN");
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

export function validateVectorOverlayDocument(input: unknown): VectorOverlayDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("VECTOR_OVERLAY_INVALID_DOCUMENT");
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error("VECTOR_OVERLAY_INVALID_VERSION");
  }
  if (typeof raw.layoutId !== "string" || !VALID_LAYOUT_IDS.has(raw.layoutId)) {
    throw new Error("VECTOR_OVERLAY_INVALID_LAYOUT");
  }
  if (typeof raw.themeId !== "string" || !VALID_THEME_IDS.has(raw.themeId)) {
    throw new Error("VECTOR_OVERLAY_INVALID_THEME");
  }
  if (!Array.isArray(raw.elements) || raw.elements.length === 0 || raw.elements.length > 40) {
    throw new Error("VECTOR_OVERLAY_EMPTY_ELEMENTS");
  }

  const theme = VECTOR_OVERLAY_THEMES[raw.themeId as VectorOverlayThemeId];
  const elements: VectorOverlayElement[] = raw.elements.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`VECTOR_OVERLAY_INVALID_ELEMENT_${index}`);
    }
    const el = item as Record<string, unknown>;
    const id = optionalTrimmedString(el.id);
    if (!id) throw new Error(`VECTOR_OVERLAY_INVALID_ELEMENT_ID_${index}`);
    if (typeof el.type !== "string" || !VALID_TYPES.has(el.type)) {
      throw new Error(`VECTOR_OVERLAY_INVALID_ELEMENT_TYPE_${index}`);
    }
    const text = optionalTrimmedString(el.text);
    if (!text) {
      throw new Error(`VECTOR_OVERLAY_EMPTY_TEXT_${index}`);
    }
    const x = clamp(requireFiniteNumber(el.x, "x"), 0, 0.98);
    const y = clamp(requireFiniteNumber(el.y, "y"), 0, 0.98);
    const width = clamp(requireFiniteNumber(el.width, "width"), 0.04, 1);
    const height = clamp(requireFiniteNumber(el.height, "height"), 0.03, 1);
    const fontSize = clamp(requireFiniteNumber(el.fontSize ?? 0.032, "fontSize"), 0.012, 0.18);
    const align = normalizeAlign(el.align);

    if (el.type === "text") {
      const fontWeight = typeof el.fontWeight === "number" && Number.isFinite(el.fontWeight)
        ? clamp(Math.round(el.fontWeight), 400, 900)
        : 700;
      const subtext = optionalTrimmedString(el.subtext);
      const bgColor = optionalTrimmedString(el.bgColor);
      return {
        id,
        type: "text",
        x,
        y,
        width,
        height,
        text,
        ...(subtext ? { subtext } : {}),
        fontSize,
        fontWeight,
        color: normalizeColor(el.color, theme.textColor),
        ...(bgColor ? { bgColor } : {}),
        align,
      };
    }

    if (el.type === "pill") {
      const icon = optionalTrimmedString(el.icon) ?? "spark";
      const borderColor = optionalTrimmedString(el.borderColor);
      return {
        id,
        type: "pill",
        x,
        y,
        width,
        height,
        text,
        icon,
        fontSize,
        color: normalizeColor(el.color, theme.pillTextColor),
        bgColor: normalizeColor(el.bgColor, theme.pillBgColor),
        ...(borderColor ? { borderColor } : {}),
        align,
      };
    }

    if (el.type === "callout") {
      const anchorX = clamp(requireFiniteNumber(el.anchorX, "anchorX"), 0, 1);
      const anchorY = clamp(requireFiniteNumber(el.anchorY, "anchorY"), 0, 1);
      const subtext = optionalTrimmedString(el.subtext);
      return {
        id,
        type: "callout",
        x,
        y,
        width,
        height,
        anchorX,
        anchorY,
        text,
        ...(subtext ? { subtext } : {}),
        fontSize,
        color: normalizeColor(el.color, theme.textColor),
        bgColor: normalizeColor(el.bgColor, theme.cardBgColor),
        lineColor: normalizeColor(el.lineColor, theme.lineColor),
        align,
      };
    }

    const subtext = optionalTrimmedString(el.subtext);
    const borderColor = optionalTrimmedString(el.borderColor);
    return {
      id,
      type: "card",
      x,
      y,
      width,
      height,
      text,
      ...(subtext ? { subtext } : {}),
      fontSize,
      color: normalizeColor(el.color, theme.textColor),
      bgColor: normalizeColor(el.bgColor, theme.cardBgColor),
      ...(borderColor ? { borderColor } : {}),
      align,
    };
  });

  return {
    version: 1,
    layoutId: raw.layoutId as VectorOverlayLayoutId,
    themeId: raw.themeId as VectorOverlayThemeId,
    elements,
  };
}

export function safeValidateVectorOverlayDocument(
  input: unknown,
): { ok: true; value: VectorOverlayDocument } | { ok: false; error: string } {
  try {
    return { ok: true, value: validateVectorOverlayDocument(input) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "VECTOR_OVERLAY_INVALID_DOCUMENT",
    };
  }
}

export function resolveThemeIdForVisualStyle(visualStyle?: string | null): VectorOverlayThemeId {
  switch (visualStyle) {
    case "dark_tech":
      return "dark_tech";
    case "vibrant_promo":
      return "vibrant_promo";
    case "natural_lifestyle":
      return "natural_warm";
    case "minimal_luxury":
    default:
      return "minimal_light";
  }
}

const DEFAULT_HEADLINE = "核心卖点升级";
const DEFAULT_SUBHEAD = "严选材质与匠心工艺";
const DEFAULT_POINTS = ["高效稳固结构", "精选耐用材质", "多场景适配"];

function resolveSeedValues(seed?: VectorOverlaySeed) {
  const headline = seed?.headline?.trim() || DEFAULT_HEADLINE;
  const subhead = seed?.subhead?.trim() || DEFAULT_SUBHEAD;
  const rawPoints = (seed?.points ?? [])
    .map((point) => point.trim())
    .filter(Boolean);
  const points = [
    rawPoints[0] ?? DEFAULT_POINTS[0],
    rawPoints[1] ?? DEFAULT_POINTS[1],
    rawPoints[2] ?? DEFAULT_POINTS[2],
  ];
  const themeId: VectorOverlayThemeId =
    seed?.themeId && VALID_THEME_IDS.has(seed.themeId) ? seed.themeId : "dark_tech";
  return { headline, subhead, points, themeId, theme: VECTOR_OVERLAY_THEMES[themeId] };
}

export function createVectorOverlayPreset(
  layoutId: VectorOverlayLayoutId,
  seed?: VectorOverlaySeed,
): VectorOverlayDocument {
  const { headline, subhead, points, themeId, theme } = resolveSeedValues(seed);
  const effectiveLayout = layoutId === "custom" ? "hero_color_block" : layoutId;
  let elements: VectorOverlayElement[];

  switch (effectiveLayout) {
    case "hero_color_block":
      elements = [
        {
          id: "hero-title",
          type: "text",
          x: 0.08,
          y: 0.06,
          width: 0.84,
          height: 0.14,
          text: headline,
          subtext: subhead,
          fontSize: 0.05,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "center",
        },
        {
          id: "hero-pill",
          type: "pill",
          x: 0.24,
          y: 0.83,
          width: 0.52,
          height: 0.085,
          text: points[0],
          icon: "spark",
          fontSize: 0.032,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
      ];
      break;

    case "macro_callout_lines":
      elements = [
        {
          id: "macro-callout-1",
          type: "callout",
          x: 0.05,
          y: 0.08,
          width: 0.34,
          height: 0.11,
          anchorX: 0.44,
          anchorY: 0.34,
          text: points[0],
          subtext: "微观工艺细节",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          lineColor: theme.lineColor,
          align: "left",
        },
        {
          id: "macro-callout-2",
          type: "callout",
          x: 0.61,
          y: 0.16,
          width: 0.34,
          height: 0.11,
          anchorX: 0.58,
          anchorY: 0.48,
          text: points[1],
          subtext: "精准质感处理",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          lineColor: theme.lineColor,
          align: "left",
        },
        {
          id: "macro-callout-3",
          type: "callout",
          x: 0.61,
          y: 0.56,
          width: 0.34,
          height: 0.11,
          anchorX: 0.48,
          anchorY: 0.63,
          text: points[2],
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          lineColor: theme.lineColor,
          align: "left",
        },
        {
          id: "macro-footer-title",
          type: "text",
          x: 0.06,
          y: 0.79,
          width: 0.88,
          height: 0.14,
          text: headline,
          subtext: subhead,
          fontSize: 0.044,
          fontWeight: 700,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
      ];
      break;

    case "scene_circle_zoom":
      elements = [
        {
          id: "scene-headline",
          type: "text",
          x: 0.06,
          y: 0.06,
          width: 0.52,
          height: 0.15,
          text: headline,
          subtext: subhead,
          fontSize: 0.046,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "scene-zoom-callout",
          type: "callout",
          x: 0.56,
          y: 0.50,
          width: 0.38,
          height: 0.12,
          anchorX: 0.74,
          anchorY: 0.28,
          text: points[0],
          subtext: points[1],
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          lineColor: theme.lineColor,
          align: "left",
        },
        {
          id: "scene-pill",
          type: "pill",
          x: 0.06,
          y: 0.84,
          width: 0.38,
          height: 0.08,
          text: points[2],
          icon: "check",
          fontSize: 0.028,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
      ];
      break;

    case "ambient_three_icons":
      elements = [
        {
          id: "ambient-title",
          type: "text",
          x: 0.08,
          y: 0.06,
          width: 0.84,
          height: 0.13,
          text: headline,
          subtext: subhead,
          fontSize: 0.048,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "center",
        },
        {
          id: "ambient-pill-1",
          type: "pill",
          x: 0.05,
          y: 0.83,
          width: 0.28,
          height: 0.085,
          text: points[0],
          icon: "bolt",
          fontSize: 0.026,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "ambient-pill-2",
          type: "pill",
          x: 0.36,
          y: 0.83,
          width: 0.28,
          height: 0.085,
          text: points[1],
          icon: "shield",
          fontSize: 0.026,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "ambient-pill-3",
          type: "pill",
          x: 0.67,
          y: 0.83,
          width: 0.28,
          height: 0.085,
          text: points[2],
          icon: "leaf",
          fontSize: 0.026,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
      ];
      break;

    case "top_hero_bottom_trio":
      elements = [
        {
          id: "trio-title",
          type: "text",
          x: 0.06,
          y: 0.06,
          width: 0.56,
          height: 0.14,
          text: headline,
          subtext: subhead,
          fontSize: 0.044,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "trio-card-1",
          type: "card",
          x: 0.05,
          y: 0.75,
          width: 0.28,
          height: 0.18,
          text: points[0],
          subtext: "局部特写 01",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "trio-card-2",
          type: "card",
          x: 0.36,
          y: 0.75,
          width: 0.28,
          height: 0.18,
          text: points[1],
          subtext: "局部特写 02",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "trio-card-3",
          type: "card",
          x: 0.67,
          y: 0.75,
          width: 0.28,
          height: 0.18,
          text: points[2],
          subtext: "局部特写 03",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
      ];
      break;

    case "left_pills_right_hero":
      elements = [
        {
          id: "left-title",
          type: "text",
          x: 0.06,
          y: 0.07,
          width: 0.44,
          height: 0.15,
          text: headline,
          subtext: subhead,
          fontSize: 0.044,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "left-pill-1",
          type: "pill",
          x: 0.06,
          y: 0.28,
          width: 0.36,
          height: 0.082,
          text: points[0],
          icon: "bolt",
          fontSize: 0.028,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "left",
        },
        {
          id: "left-pill-2",
          type: "pill",
          x: 0.06,
          y: 0.40,
          width: 0.36,
          height: 0.082,
          text: points[1],
          icon: "shield",
          fontSize: 0.028,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "left",
        },
        {
          id: "left-pill-3",
          type: "pill",
          x: 0.06,
          y: 0.52,
          width: 0.36,
          height: 0.082,
          text: points[2],
          icon: "check",
          fontSize: 0.028,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "left",
        },
        {
          id: "left-summary-card",
          type: "card",
          x: 0.06,
          y: 0.72,
          width: 0.36,
          height: 0.16,
          text: points[0],
          subtext: subhead,
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "left",
        },
      ];
      break;

    case "hero_zoom_spec_box":
      elements = [
        {
          id: "spec-title",
          type: "text",
          x: 0.06,
          y: 0.06,
          width: 0.88,
          height: 0.13,
          text: headline,
          subtext: subhead,
          fontSize: 0.044,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "spec-callout",
          type: "callout",
          x: 0.56,
          y: 0.27,
          width: 0.38,
          height: 0.14,
          anchorX: 0.42,
          anchorY: 0.48,
          text: points[0],
          subtext: "核心参数位置",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          lineColor: theme.lineColor,
          align: "left",
        },
        {
          id: "spec-detail-card",
          type: "card",
          x: 0.56,
          y: 0.50,
          width: 0.38,
          height: 0.26,
          text: points[1],
          subtext: `${points[2]} · ${subhead}`,
          fontSize: 0.03,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "left",
        },
      ];
      break;

    case "top_cards_bottom_hero":
      elements = [
        {
          id: "top-card-1",
          type: "card",
          x: 0.05,
          y: 0.06,
          width: 0.28,
          height: 0.17,
          text: points[0],
          subtext: "亮点 01",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "top-card-2",
          type: "card",
          x: 0.36,
          y: 0.06,
          width: 0.28,
          height: 0.17,
          text: points[1],
          subtext: "亮点 02",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "top-card-3",
          type: "card",
          x: 0.67,
          y: 0.06,
          width: 0.28,
          height: 0.17,
          text: points[2],
          subtext: "亮点 03",
          fontSize: 0.028,
          color: theme.textColor,
          bgColor: theme.cardBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "bottom-hero-title",
          type: "text",
          x: 0.08,
          y: 0.81,
          width: 0.84,
          height: 0.13,
          text: headline,
          subtext: subhead,
          fontSize: 0.046,
          fontWeight: 800,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "center",
        },
      ];
      break;

    case "split_scene_closeup":
      elements = [
        {
          id: "split-left-title",
          type: "text",
          x: 0.05,
          y: 0.06,
          width: 0.42,
          height: 0.13,
          text: headline,
          subtext: "真实使用场景",
          fontSize: 0.038,
          fontWeight: 700,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "split-right-title",
          type: "text",
          x: 0.53,
          y: 0.06,
          width: 0.42,
          height: 0.13,
          text: points[0],
          subtext: "近景工艺特写",
          fontSize: 0.038,
          fontWeight: 700,
          color: theme.textColor,
          bgColor: theme.bgColor,
          align: "left",
        },
        {
          id: "split-left-pill",
          type: "pill",
          x: 0.05,
          y: 0.83,
          width: 0.40,
          height: 0.08,
          text: points[1],
          icon: "leaf",
          fontSize: 0.026,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
        {
          id: "split-right-pill",
          type: "pill",
          x: 0.53,
          y: 0.83,
          width: 0.40,
          height: 0.08,
          text: points[2],
          icon: "spark",
          fontSize: 0.026,
          color: theme.pillTextColor,
          bgColor: theme.pillBgColor,
          borderColor: theme.borderColor,
          align: "center",
        },
      ];
      break;
  }

  return {
    version: 1,
    layoutId,
    themeId,
    elements,
  };
}

export function createVectorOverlayElement(
  type: VectorOverlayElementType,
  themeId: VectorOverlayThemeId,
  index = 0,
): VectorOverlayElement {
  const theme = VECTOR_OVERLAY_THEMES[themeId] ?? VECTOR_OVERLAY_THEMES.dark_tech;
  const id = `${type}-${Date.now().toString(36)}-${index}`;
  const offset = (index % 5) * 0.035;

  switch (type) {
    case "text":
      return {
        id,
        type: "text",
        x: 0.08,
        y: clamp(0.08 + offset, 0.04, 0.78),
        width: 0.62,
        height: 0.13,
        text: "新卖点标题",
        subtext: "点击修改副标题文案",
        fontSize: 0.044,
        fontWeight: 800,
        color: theme.textColor,
        bgColor: theme.bgColor,
        align: "left",
      };
    case "pill":
      return {
        id,
        type: "pill",
        x: 0.08,
        y: clamp(0.68 + offset * 0.6, 0.06, 0.86),
        width: 0.36,
        height: 0.082,
        text: "核心卖点胶囊",
        icon: "spark",
        fontSize: 0.028,
        color: theme.pillTextColor,
        bgColor: theme.pillBgColor,
        borderColor: theme.borderColor,
        align: "center",
      };
    case "callout":
      return {
        id,
        type: "callout",
        x: 0.56,
        y: clamp(0.24 + offset, 0.06, 0.76),
        width: 0.36,
        height: 0.12,
        anchorX: 0.44,
        anchorY: 0.46,
        text: "工艺细节标注",
        subtext: "点击拖拽调整指示位置",
        fontSize: 0.028,
        color: theme.textColor,
        bgColor: theme.cardBgColor,
        lineColor: theme.lineColor,
        align: "left",
      };
    case "card":
      return {
        id,
        type: "card",
        x: clamp(0.10 + offset, 0.05, 0.55),
        y: clamp(0.70 + offset * 0.5, 0.06, 0.76),
        width: 0.34,
        height: 0.17,
        text: "卖点信息卡",
        subtext: "填写简短可核实的商品优势说明",
        fontSize: 0.028,
        color: theme.textColor,
        bgColor: theme.cardBgColor,
        borderColor: theme.borderColor,
        align: "left",
      };
  }
}

export function extractOverlaySeedFromText(input: {
  title?: string | null;
  purpose?: string | null;
  promptDraft?: string | null;
  textContent?: Array<{ text: string; source?: string }> | null;
  themeId?: VectorOverlayThemeId;
}): VectorOverlaySeed {
  const structuredTexts = (input.textContent ?? [])
    .map((entry) => entry.text.trim())
    .filter(Boolean);

  const promptQuotes = [...(input.promptDraft ?? "").matchAll(/["“「]([^"”」\n]{2,28})["”」]/g)]
    .map((match) => match[1].trim())
    .filter((value) => !value.includes("系统安全") && !value.includes("平台约束"));

  const combined = [...new Set([...structuredTexts, ...promptQuotes])];
  const rawTitle = input.title?.trim() || "";
  const rawPurpose = input.purpose?.trim() || "";

  const headline = combined[0] ?? (rawTitle || DEFAULT_HEADLINE);
  const subhead = combined[1] ?? (rawPurpose && rawPurpose !== headline ? rawPurpose : DEFAULT_SUBHEAD);
  const points = combined.length > 1
    ? combined.slice(1)
    : rawPurpose && rawPurpose !== headline
      ? [rawPurpose, ...DEFAULT_POINTS.slice(0, 2)]
      : [...DEFAULT_POINTS];

  return {
    headline,
    subhead,
    points,
    themeId: input.themeId,
  };
}
