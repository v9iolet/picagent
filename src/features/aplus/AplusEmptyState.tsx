const examples = [
  { module: "核心卖点图", src: "/suite/showcase/05-selling-points.webp" },
  { module: "使用场景图", src: "/suite/showcase/02-scene-display.webp" },
  { module: "商品细节图", src: "/suite/showcase/04-detail-callouts.webp" },
];

export function AplusEmptyState() {
  return (
    <section className="aplus-showcase" aria-label="详情图示例">
      <header>
        <h3>用模块组织商品详情</h3>
        <p>上传商品原图并选择模块，确认策划方案后逐张生成详情图。</p>
      </header>
      <div className="aplus-showcase-grid">
        {examples.map(({ module, src }) => (
          <figure key={module}>
            <img src={src} alt={`${module}示例`} />
            <figcaption>{module}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
