const SHOWCASE_CASES = [
  {
    id: "case1",
    title: "极简棚拍主图",
    scene: "电商商品图",
    level: "高度复刻",
    before: "/replica/showcase/case1-before.webp",
    after: "/replica/showcase/case1-after.webp",
  },
  {
    id: "case2",
    title: "秋冬质感穿搭",
    scene: "服饰电商图",
    level: "参考风格",
    before: "/replica/showcase/case2-before.webp",
    after: "/replica/showcase/case2-after.webp",
  },
  {
    id: "case3",
    title: "大促活动海报",
    scene: "营销海报",
    level: "高度复刻",
    before: "/replica/showcase/case3-before.webp",
    after: "/replica/showcase/case3-after.webp",
  },
  {
    id: "case4",
    title: "种草封面图文",
    scene: "社媒图文",
    level: "参考风格",
    before: "/replica/showcase/case4-before.webp",
    after: "/replica/showcase/case4-after.webp",
  },
] as const;

export function ReplicaEmptyState() {
  return (
    <div className="ss-empty rp-empty">
      <div className="ss-eyebrow">PRODUCT REPLICA</div>
      <h2>爆品图复刻</h2>
      <p>上传参考爆品图与产品原图，一键复刻构图、光影与版式，快速生成同款商品图。</p>
      <div className="rp-showcase-grid" aria-label="爆品图复刻前后对比案例">
        {SHOWCASE_CASES.map((item) => (
          <article key={item.id} className="rp-showcase-card">
            <div className="rp-showcase-pair">
              <figure>
                <img src={item.before} alt={`${item.title} 参考图`} />
                <figcaption>参考图</figcaption>
              </figure>
              <span className="rp-showcase-arrow" aria-hidden="true">→</span>
              <figure>
                <img src={item.after} alt={`${item.title} 复刻效果`} />
                <figcaption>复刻图</figcaption>
              </figure>
            </div>
            <div className="rp-showcase-meta">
              <strong>{item.title}</strong>
              <span>{item.scene} · {item.level}</span>
            </div>
          </article>
        ))}
      </div>
      <small>静态前后对比示例 · 在左侧上传 1–6 张参考图即可开始复刻</small>
    </div>
  );
}
