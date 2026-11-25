import "./suite-empty-state.css";

interface ShowcaseSlot {
  id: string;
  badge: string;
  src: string;
  alt: string;
}

const HERO_SLOT: ShowcaseSlot = {
  id: "main-white",
  badge: "01 主图（白底/合规）",
  src: "/suite/showcase/01-main-white.webp",
  alt: "01 主图（白底/合规）生成实例",
};

const GRID_SLOTS: readonly ShowcaseSlot[] = [
  {
    id: "scene-display",
    badge: "02 场景展示",
    src: "/suite/showcase/02-scene-display.webp",
    alt: "02 场景展示生成实例",
  },
  {
    id: "model-lifestyle",
    badge: "03 模特场景图",
    src: "/suite/showcase/03-model-lifestyle.webp",
    alt: "03 模特场景图生成实例",
  },
  {
    id: "detail-callouts",
    badge: "04 细节说明",
    src: "/suite/showcase/04-detail-callouts.webp",
    alt: "04 细节说明生成实例",
  },
  {
    id: "selling-points",
    badge: "05 卖点详解",
    src: "/suite/showcase/05-selling-points.webp",
    alt: "05 卖点详解生成实例",
  },
];

export function SuiteEmptyState() {
  return (
    <div className="ss-showcase-empty">
      <header className="ss-showcase-head">
        <h2>AI 商品套图</h2>
        <p className="ss-showcase-subtitle">
          上传商品图，AI 即刻生成 <strong>符合多电商平台规范</strong> 的高转化率商品套图。
        </p>
      </header>

      <div className="ss-showcase-board" role="group" aria-label="AI 商品套图生成实例">
        <figure className="ss-showcase-hero">
          <span className="ss-showcase-badge">{HERO_SLOT.badge}</span>
          <img src={HERO_SLOT.src} alt={HERO_SLOT.alt} />
        </figure>

        <div className="ss-showcase-arrow" aria-hidden="true">
          <svg viewBox="0 0 44 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M5 24C14 25 24 21 34 10"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M25.5 9.5L35 9L34.2 18.5"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <div className="ss-showcase-grid">
          {GRID_SLOTS.map((slot) => (
            <figure key={slot.id} className="ss-showcase-card">
              <span className="ss-showcase-badge">{slot.badge}</span>
              <img src={slot.src} alt={slot.alt} />
            </figure>
          ))}
        </div>
      </div>

      <small className="ss-showcase-footnote">
        真实流水线套图生成实例 · 在左侧上传商品原图即可开始创作
      </small>
    </div>
  );
}
