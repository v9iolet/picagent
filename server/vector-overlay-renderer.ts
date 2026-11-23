import sharp from "sharp";
import {
  validateVectorOverlayDocument,
  type VectorOverlayAlign,
  type VectorOverlayCalloutElement,
  type VectorOverlayCardElement,
  type VectorOverlayDocument,
  type VectorOverlayPillElement,
  type VectorOverlayTextElement,
} from "../shared/vector-overlay.js";

const FONT_STACK =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'Helvetica Neue', Arial, sans-serif";

const SAFE_COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)|transparent|[a-zA-Z]{3,20})$/;

export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeColor(color: string | undefined, fallback: string): string {
  const candidate = color?.trim() ?? "";
  return SAFE_COLOR_RE.test(candidate) ? escapeXml(candidate) : escapeXml(fallback);
}

function charWidthEstimate(ch: string, fontSize: number): number {
  const code = ch.codePointAt(0) ?? 32;
  if (code > 0x2e7f) return fontSize * 1.02;
  if (ch === " ") return fontSize * 0.32;
  if (/[A-ZWM]/.test(ch)) return fontSize * 0.68;
  if (/[0-9]/.test(ch)) return fontSize * 0.58;
  return fontSize * 0.54;
}

function wrapTextLines(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const safeMaxWidth = Math.max(fontSize * 1.5, maxWidth);
  const safeMaxLines = Math.max(1, maxLines);
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/(\s+)/);
    let current = "";
    let currentWidth = 0;

    const pushCurrent = () => {
      if (current.trim()) lines.push(current.trim());
      current = "";
      currentWidth = 0;
    };

    for (const token of tokens) {
      if (!token) continue;
      const tokenWidth = Array.from(token).reduce((sum, ch) => sum + charWidthEstimate(ch, fontSize), 0);
      if (current && currentWidth + tokenWidth <= safeMaxWidth) {
        current += token;
        currentWidth += tokenWidth;
        continue;
      }
      if (!current && tokenWidth <= safeMaxWidth) {
        current = token.trimStart();
        currentWidth = Array.from(current).reduce((sum, ch) => sum + charWidthEstimate(ch, fontSize), 0);
        continue;
      }
      if (token.trim().length === 0) {
        pushCurrent();
        continue;
      }
      for (const ch of Array.from(token)) {
        const w = charWidthEstimate(ch, fontSize);
        if (current && currentWidth + w > safeMaxWidth) {
          pushCurrent();
          if (lines.length >= safeMaxLines) break;
        }
        if (!current && ch === " ") continue;
        current += ch;
        currentWidth += w;
      }
      if (lines.length >= safeMaxLines) break;
    }
    if (lines.length < safeMaxLines) pushCurrent();
    if (lines.length >= safeMaxLines) break;
  }

  if (lines.length > safeMaxLines) {
    lines.length = safeMaxLines;
  }
  const sourceTotalChars = text.replace(/\s+/g, "").length;
  const renderedTotalChars = lines.join("").replace(/\s+/g, "").length;
  if (lines.length === safeMaxLines && renderedTotalChars < sourceTotalChars) {
    const last = lines[safeMaxLines - 1];
    lines[safeMaxLines - 1] = last.length > 1 ? `${last.slice(0, -1)}…` : `${last}…`;
  }
  return lines.length ? lines : [""];
}

function anchorForAlign(align: VectorOverlayAlign): "start" | "middle" | "end" {
  if (align === "center") return "middle";
  if (align === "right") return "end";
  return "start";
}

function xForAlign(x: number, width: number, padX: number, align: VectorOverlayAlign): number {
  if (align === "center") return x + width / 2;
  if (align === "right") return x + width - padX;
  return x + padX;
}

function renderLinesSvg(options: {
  lines: string[];
  x: number;
  startY: number;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  color: string;
  align: VectorOverlayAlign;
}): string {
  const anchor = anchorForAlign(options.align);
  return options.lines
    .map((line, index) => {
      const y = options.startY + index * options.lineHeight;
      return `<text x="${options.x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="hanging" font-family="${escapeXml(FONT_STACK)}" font-size="${options.fontSize.toFixed(1)}" font-weight="${options.fontWeight}" fill="${options.color}">${escapeXml(line)}</text>`;
    })
    .join("");
}

function renderTextElement(el: VectorOverlayTextElement, width: number, height: number): string {
  const x = el.x * width;
  const y = el.y * height;
  const boxW = el.width * width;
  const boxH = el.height * height;
  const fontSize = Math.max(12, el.fontSize * height);
  const padX = Math.max(12, Math.min(28, boxW * 0.04));
  const padY = Math.max(8, Math.min(20, boxH * 0.14));
  const innerW = Math.max(20, boxW - padX * 2);
  const lineH = fontSize * 1.24;
  const hasSub = Boolean(el.subtext?.trim());
  const subFontSize = Math.max(10, fontSize * 0.54);
  const subLineH = subFontSize * 1.25;
  const maxMainLines = Math.max(1, Math.floor((boxH - padY * 2 - (hasSub ? subLineH * 1.2 : 0)) / lineH));
  const mainLines = wrapTextLines(el.text, innerW, fontSize, maxMainLines);
  const subLines = hasSub ? wrapTextLines(el.subtext!, innerW, subFontSize, 2) : [];

  const totalTextHeight = mainLines.length * lineH + (subLines.length ? subLines.length * subLineH + fontSize * 0.2 : 0);
  const startY = y + Math.max(padY, (boxH - totalTextHeight) / 2);
  const textX = xForAlign(x, boxW, padX, el.align);
  const radius = Math.min(18, boxH * 0.18);

  const bg = el.bgColor && el.bgColor !== "transparent"
    ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${safeColor(el.bgColor, "#0F172AE6")}" filter="url(#vo-shadow)"/>`
    : "";

  const mainSvg = renderLinesSvg({
    lines: mainLines,
    x: textX,
    startY,
    fontSize,
    lineHeight: lineH,
    fontWeight: el.fontWeight ?? 700,
    color: safeColor(el.color, "#F8FAFC"),
    align: el.align,
  });

  const subSvg = subLines.length
    ? renderLinesSvg({
        lines: subLines,
        x: textX,
        startY: startY + mainLines.length * lineH + fontSize * 0.2,
        fontSize: subFontSize,
        lineHeight: subLineH,
        fontWeight: 500,
        color: safeColor(el.color, "#F8FAFC"),
        align: el.align,
      })
    : "";

  return `<g data-element-id="${escapeXml(el.id)}">${bg}${mainSvg}${subSvg}</g>`;
}

function renderPillIcon(icon: string | undefined, cx: number, cy: number, radius: number, color: string): string {
  const r = Math.max(4, radius);
  switch (icon) {
    case "bolt":
      return `<path d="M ${(cx + r * 0.1).toFixed(1)} ${(cy - r * 0.75).toFixed(1)} L ${(cx - r * 0.45).toFixed(1)} ${(cy + r * 0.08).toFixed(1)} H ${(cx + r * 0.05).toFixed(1)} L ${(cx - r * 0.1).toFixed(1)} ${(cy + r * 0.75).toFixed(1)} L ${(cx + r * 0.48).toFixed(1)} ${(cy - r * 0.08).toFixed(1)} H ${(cx - r * 0.04).toFixed(1)} Z" fill="${color}"/>`;
    case "check":
      return `<path d="M ${(cx - r * 0.55).toFixed(1)} ${(cy + r * 0.05).toFixed(1)} L ${(cx - r * 0.15).toFixed(1)} ${(cy + r * 0.45).toFixed(1)} L ${(cx + r * 0.6).toFixed(1)} ${(cy - r * 0.45).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${Math.max(1.8, r * 0.25).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "shield":
      return `<path d="M ${cx.toFixed(1)} ${(cy - r * 0.72).toFixed(1)} L ${(cx + r * 0.62).toFixed(1)} ${(cy - r * 0.42).toFixed(1)} V ${(cy + r * 0.05).toFixed(1)} C ${(cx + r * 0.62).toFixed(1)} ${(cy + r * 0.48).toFixed(1)} ${(cx + r * 0.25).toFixed(1)} ${(cy + r * 0.72).toFixed(1)} ${cx.toFixed(1)} ${(cy + r * 0.82).toFixed(1)} C ${(cx - r * 0.25).toFixed(1)} ${(cy + r * 0.72).toFixed(1)} ${(cx - r * 0.62).toFixed(1)} ${(cy + r * 0.48).toFixed(1)} ${(cx - r * 0.62).toFixed(1)} ${(cy + r * 0.05).toFixed(1)} V ${(cy - r * 0.42).toFixed(1)} Z" fill="none" stroke="${color}" stroke-width="${Math.max(1.6, r * 0.22).toFixed(1)}"/>`;
    case "leaf":
      return `<path d="M ${(cx - r * 0.55).toFixed(1)} ${(cy + r * 0.55).toFixed(1)} C ${(cx - r * 0.6).toFixed(1)} ${(cy - r * 0.25).toFixed(1)} ${(cx + r * 0.05).toFixed(1)} ${(cy - r * 0.72).toFixed(1)} ${(cx + r * 0.68).toFixed(1)} ${(cy - r * 0.65).toFixed(1)} C ${(cx + r * 0.7).toFixed(1)} ${(cy + r * 0.05).toFixed(1)} ${(cx + r * 0.22).toFixed(1)} ${(cy + r * 0.62).toFixed(1)} ${(cx - r * 0.55).toFixed(1)} ${(cy + r * 0.55).toFixed(1)} Z" fill="${color}" fill-opacity="0.9"/>`;
    default:
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.68).toFixed(1)}" fill="${color}" fill-opacity="0.22"/><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(r * 0.34).toFixed(1)}" fill="${color}"/>`;
  }
}

function renderPillElement(el: VectorOverlayPillElement, width: number, height: number): string {
  const x = el.x * width;
  const y = el.y * height;
  const boxW = el.width * width;
  const boxH = el.height * height;
  const radius = boxH / 2;
  const fontSize = Math.max(11, Math.min(boxH * 0.46, el.fontSize * height));
  const iconR = Math.min(boxH * 0.28, fontSize * 0.65);
  const padX = Math.max(14, boxH * 0.36);
  const iconCx = x + padX + iconR;
  const iconCy = y + boxH / 2;
  const textColor = safeColor(el.color, "#FFFFFF");
  const bgColor = safeColor(el.bgColor, "#0284C7EB");
  const borderAttr = el.borderColor
    ? ` stroke="${safeColor(el.borderColor, "#38BDF880")}" stroke-width="${Math.max(1.2, boxH * 0.028).toFixed(1)}"`
    : "";

  const textStartOffset = padX + iconR * 2 + 8;
  const textAreaW = Math.max(20, boxW - textStartOffset - padX * 0.7);
  const lines = wrapTextLines(el.text, textAreaW, fontSize, 2);
  const lineH = fontSize * 1.18;
  const startY = y + Math.max(4, (boxH - lines.length * lineH) / 2);
  const textX = el.align === "center"
    ? x + textStartOffset + textAreaW / 2
    : el.align === "right"
      ? x + boxW - padX
      : x + textStartOffset;

  return `<g data-element-id="${escapeXml(el.id)}">
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${bgColor}"${borderAttr} filter="url(#vo-shadow)"/>
    ${renderPillIcon(el.icon, iconCx, iconCy, iconR, textColor)}
    ${renderLinesSvg({ lines, x: textX, startY, fontSize, lineHeight: lineH, fontWeight: 700, color: textColor, align: el.align })}
  </g>`;
}

function renderCalloutElement(el: VectorOverlayCalloutElement, width: number, height: number): string {
  const x = el.x * width;
  const y = el.y * height;
  const boxW = el.width * width;
  const boxH = el.height * height;
  const ax = el.anchorX * width;
  const ay = el.anchorY * height;

  const boxCenterX = x + boxW / 2;
  const boxCenterY = y + boxH / 2;
  const attachX = ax < x ? x : ax > x + boxW ? x + boxW : boxCenterX;
  const attachY = Math.abs(ay - boxCenterY) > boxH * 0.42
    ? (ay < boxCenterY ? y : y + boxH)
    : boxCenterY;
  const elbowX = ax + (attachX - ax) * 0.55;
  const pointsAttr = `${ax.toFixed(1)},${ay.toFixed(1)} ${elbowX.toFixed(1)},${attachY.toFixed(1)} ${attachX.toFixed(1)},${attachY.toFixed(1)}`;
  const lineColor = safeColor(el.lineColor, "#38BDF8");
  const strokeW = Math.max(1.8, Math.min(4, Math.min(width, height) * 0.0032));
  const dotR = Math.max(4, strokeW * 2.2);

  const fontSize = Math.max(11, el.fontSize * height);
  const subFontSize = Math.max(9.5, fontSize * 0.66);
  const padX = Math.max(10, boxW * 0.06);
  const padY = Math.max(8, boxH * 0.14);
  const innerW = Math.max(20, boxW - padX * 2);
  const lineH = fontSize * 1.22;
  const subLineH = subFontSize * 1.22;
  const hasSub = Boolean(el.subtext?.trim());
  const maxMainLines = Math.max(1, Math.floor((boxH - padY * 2 - (hasSub ? subLineH : 0)) / lineH));
  const mainLines = wrapTextLines(el.text, innerW, fontSize, maxMainLines);
  const subLines = hasSub ? wrapTextLines(el.subtext!, innerW, subFontSize, 2) : [];
  const totalH = mainLines.length * lineH + (subLines.length ? subLines.length * subLineH + 3 : 0);
  const startY = y + Math.max(padY, (boxH - totalH) / 2);
  const textX = xForAlign(x, boxW, padX, el.align);
  const radius = Math.min(14, boxH * 0.18);
  const textColor = safeColor(el.color, "#F8FAFC");
  const bgColor = safeColor(el.bgColor, "#1E293BE8");

  return `<g data-element-id="${escapeXml(el.id)}">
    <polyline points="${pointsAttr}" fill="none" stroke="#FFFFFFCC" stroke-width="${(strokeW + 2).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${pointsAttr}" fill="none" stroke="${lineColor}" stroke-width="${strokeW.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${(dotR * 1.75).toFixed(1)}" fill="${lineColor}" fill-opacity="0.24" stroke="#FFFFFFE6" stroke-width="${Math.max(1.2, strokeW * 0.7).toFixed(1)}"/>
    <circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${dotR.toFixed(1)}" fill="${lineColor}"/>
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${bgColor}" stroke="${lineColor}" stroke-opacity="0.6" stroke-width="${Math.max(1.2, strokeW * 0.75).toFixed(1)}" filter="url(#vo-shadow)"/>
    ${renderLinesSvg({ lines: mainLines, x: textX, startY, fontSize, lineHeight: lineH, fontWeight: 700, color: textColor, align: el.align })}
    ${subLines.length ? renderLinesSvg({ lines: subLines, x: textX, startY: startY + mainLines.length * lineH + 3, fontSize: subFontSize, lineHeight: subLineH, fontWeight: 500, color: textColor, align: el.align }) : ""}
  </g>`;
}

function renderCardElement(el: VectorOverlayCardElement, width: number, height: number): string {
  const x = el.x * width;
  const y = el.y * height;
  const boxW = el.width * width;
  const boxH = el.height * height;
  const radius = Math.min(18, boxH * 0.16);
  const fontSize = Math.max(11, el.fontSize * height);
  const subFontSize = Math.max(9.5, fontSize * 0.68);
  const padX = Math.max(12, boxW * 0.07);
  const padY = Math.max(10, boxH * 0.14);
  const innerW = Math.max(20, boxW - padX * 2);
  const lineH = fontSize * 1.24;
  const subLineH = subFontSize * 1.26;
  const hasSub = Boolean(el.subtext?.trim());
  const maxMainLines = Math.max(1, Math.floor((boxH - padY * 2 - (hasSub ? subLineH : 0)) / lineH));
  const mainLines = wrapTextLines(el.text, innerW, fontSize, maxMainLines);
  const subLines = hasSub
    ? wrapTextLines(el.subtext!, innerW, subFontSize, Math.max(1, Math.floor((boxH - padY * 2 - mainLines.length * lineH) / subLineH)))
    : [];
  const totalH = mainLines.length * lineH + (subLines.length ? subLines.length * subLineH + 4 : 0);
  const startY = y + Math.max(padY, (boxH - totalH) / 2);
  const textX = xForAlign(x, boxW, padX, el.align);
  const textColor = safeColor(el.color, "#F8FAFC");
  const bgColor = safeColor(el.bgColor, "#1E293BE8");
  const borderColor = safeColor(el.borderColor, "#CBD5E1");
  const accentH = Math.max(3, Math.min(6, boxH * 0.04));

  return `<g data-element-id="${escapeXml(el.id)}">
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="${radius.toFixed(1)}" fill="${bgColor}" stroke="${borderColor}" stroke-width="1.5" filter="url(#vo-shadow)"/>
    <rect x="${(x + padX).toFixed(1)}" y="${(y + 6).toFixed(1)}" width="${Math.max(24, Math.min(54, boxW * 0.24)).toFixed(1)}" height="${accentH.toFixed(1)}" rx="${(accentH / 2).toFixed(1)}" fill="${borderColor}"/>
    ${renderLinesSvg({ lines: mainLines, x: textX, startY, fontSize, lineHeight: lineH, fontWeight: 700, color: textColor, align: el.align })}
    ${subLines.length ? renderLinesSvg({ lines: subLines, x: textX, startY: startY + mainLines.length * lineH + 4, fontSize: subFontSize, lineHeight: subLineH, fontWeight: 500, color: textColor, align: el.align }) : ""}
  </g>`;
}

export function renderVectorOverlaySvg(
  overlay: VectorOverlayDocument,
  width: number,
  height: number,
): string {
  const validated = validateVectorOverlayDocument(overlay);
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));

  const body = validated.elements
    .map((el) => {
      switch (el.type) {
        case "text":
          return renderTextElement(el, w, h);
        case "pill":
          return renderPillElement(el, w, h);
        case "callout":
          return renderCalloutElement(el, w, h);
        case "card":
          return renderCardElement(el, w, h);
      }
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <filter id="vo-shadow" x="-12%" y="-12%" width="124%" height="128%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0F172A" flood-opacity="0.22"/>
    </filter>
  </defs>
  ${body}
</svg>`;
}

export async function compositeVectorOverlay(
  baseImageBytes: Buffer,
  overlay: VectorOverlayDocument,
): Promise<{ bytes: Buffer; width: number; height: number; mimeType: "image/png" }> {
  const validated = validateVectorOverlayDocument(overlay);
  const base = await sharp(baseImageBytes, { failOn: "error" }).rotate().png().toBuffer({ resolveWithObject: true });
  const width = base.info.width;
  const height = base.info.height;
  if (!width || !height) {
    throw new Error("INVALID_BASE_IMAGE");
  }
  const svg = renderVectorOverlaySvg(validated, width, height);
  const bytes = await sharp(base.data)
    .composite([{ input: Buffer.from(svg, "utf8"), top: 0, left: 0 }])
    .png()
    .toBuffer();
  return {
    bytes,
    width,
    height,
    mimeType: "image/png",
  };
}
