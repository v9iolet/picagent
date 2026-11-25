import { InfoTip } from "../ui/InfoTip";
import "./ProductImageGuideTip.css";

interface GuideTile {
  src: string;
  alt: string;
  valid: boolean;
  tag?: string;
}

const GUIDE_TILES: readonly GuideTile[] = [
  {
    src: "/guide/product-upload/angle-1-front.webp",
    alt: "正确示例：完整多视角首张主参考图",
    valid: true,
    tag: "首张",
  },
  {
    src: "/guide/product-upload/angle-2-tilt.webp",
    alt: "正确示例：同一商品侧面视角原图",
    valid: true,
  },
  {
    src: "/guide/product-upload/angle-3-back.webp",
    alt: "正确示例：同一商品背面视角原图",
    valid: true,
  },
  {
    src: "/guide/product-upload/bad-1-partial.webp",
    alt: "错误示例：首张仅局部特写",
    valid: false,
    tag: "首张非局部",
  },
  {
    src: "/guide/product-upload/bad-2-blurry.webp",
    alt: "错误示例：画面模糊不清",
    valid: false,
    tag: "模糊",
  },
  {
    src: "/guide/product-upload/bad-3-collage.webp",
    alt: "错误示例：多图拼贴或带局部放大框",
    valid: false,
    tag: "拼图",
  },
];

export function ProductImageGuideTip({ label }: { label: string }) {
  return (
    <InfoTip
      label={label}
      align="start"
      placement="bottom"
      popoverClassName="pig-popover"
      content={
        <div className="pig-content">
          <div className="pig-rules">
            <p>1.可上传同一商品的多视角原图，帮助 AI 更准确还原商品细节。</p>
            <p>2.最多支持 6 张图片，第一张将作为主图重点参考，建议选择角度最全的一张。</p>
          </div>
          <div className="pig-grid">
            {GUIDE_TILES.map((tile) => (
              <div className="pig-tile" key={tile.src}>
                <img src={tile.src} alt={tile.alt} />
                <span
                  className={`pig-badge ${tile.valid ? "is-valid" : "is-invalid"}`}
                  aria-hidden="true"
                >
                  {tile.valid ? (
                    <svg viewBox="0 0 16 16" fill="none">
                      <path
                        d="M3.5 8.3L6.6 11.4L12.5 4.8"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none">
                      <path
                        d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </span>
                {tile.tag && (
                  <span className={`pig-tag${tile.tag.length >= 4 ? " is-wide" : ""}`}>
                    {tile.tag}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}
