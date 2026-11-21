import { useEffect, useMemo, useState } from "react";
import {
  DELIVERY_EXPORT_PRESETS,
  evaluateDeliveryCompliance,
  resolveDeliverySlots,
  type DeliveryExportFormat,
  type DeliveryExportPresetId,
  type DeliverySourceRole,
  type ResolvedDeliverySlot,
} from "../../shared/workbench-delivery";
import { suiteApi, type ApiWorkbench } from "../api/client";
import { Icon, ImageWithState } from "../pages/shared";
import "./DeliveryGalleryView.css";

const ROLE_LABELS: Record<DeliverySourceRole, { label: string; tone: string }> = {
  edit_final: { label: "编辑终版", tone: "final" },
  parent_final: { label: "终版", tone: "final" },
  edit_current: { label: "编辑当前版", tone: "derived" },
  parent_current: { label: "回退当前版", tone: "current" },
  pending: { label: "待生成", tone: "pending" },
};

const PRESET_LIST = Object.values(DELIVERY_EXPORT_PRESETS);

export function DeliveryGalleryView({
  workbench,
  effectiveStyleGuide,
  onPreview,
  onNotify,
}: {
  workbench: ApiWorkbench;
  effectiveStyleGuide: string;
  onPreview: (slot: ResolvedDeliverySlot) => void;
  onNotify: (message: string) => void;
}) {
  const [subView, setSubView] = useState<"storefront" | "grid">("storefront");
  const [deviceMode, setDeviceMode] = useState<"desktop" | "mobile">("desktop");
  const [exportPreset, setExportPreset] = useState<DeliveryExportPresetId>("original");
  const [exportFormat, setExportFormat] = useState<DeliveryExportFormat>("original");
  const [exportQuality, setExportQuality] = useState(90);
  const [stitchDetail, setStitchDetail] = useState(false);
  const [exporting, setExporting] = useState(false);

  const slots = useMemo(
    () => resolveDeliverySlots(workbench.tasks, workbench.imageEditChildren ?? [], { defaultTemplateVersionId: workbench.planSnapshot?.templateVersionId ?? null }),
    [workbench.tasks, workbench.imageEditChildren, workbench.planSnapshot?.templateVersionId],
  );
  const mainSlots = useMemo(() => slots.filter((slot) => slot.imageType === "main"), [slots]);
  const detailSlots = useMemo(() => slots.filter((slot) => slot.imageType === "detail"), [slots]);
  const deliverableSlots = useMemo(() => slots.filter((slot) => slot.sourceRole !== "pending"), [slots]);
  const deliverableDetails = useMemo(() => detailSlots.filter((slot) => slot.sourceRole !== "pending"), [detailSlots]);
  const finalCount = useMemo(() => slots.filter((slot) => slot.sourceRole === "edit_final" || slot.sourceRole === "parent_final").length, [slots]);
  const derivedCount = useMemo(() => slots.filter((slot) => slot.isEditedDerived).length, [slots]);
  const compliance = useMemo(() => evaluateDeliveryCompliance(slots, exportPreset), [slots, exportPreset]);

  const [activeMainId, setActiveMainId] = useState<string>("");
  const [selectedSlotKey, setSelectedSlotKey] = useState<string>("");

  useEffect(() => {
    if (!mainSlots.some((slot) => slot.parentTaskId === activeMainId)) {
      setActiveMainId(mainSlots[0]?.parentTaskId ?? "");
    }
    if (!slots.some((slot) => slot.parentTaskId === selectedSlotKey)) {
      setSelectedSlotKey(deliverableSlots[0]?.parentTaskId ?? slots[0]?.parentTaskId ?? "");
    }
  }, [slots, mainSlots, deliverableSlots, activeMainId, selectedSlotKey]);

  const activeMainSlot = mainSlots.find((slot) => slot.parentTaskId === activeMainId) ?? mainSlots[0] ?? null;
  const selectedSlot = slots.find((slot) => slot.parentTaskId === selectedSlotKey) ?? deliverableSlots[0] ?? slots[0] ?? null;
  const activePresetMeta = DELIVERY_EXPORT_PRESETS[exportPreset];

  const handlePresetChange = (nextPreset: DeliveryExportPresetId) => {
    setExportPreset(nextPreset);
    const meta = DELIVERY_EXPORT_PRESETS[nextPreset];
    setExportFormat(meta.defaultFormat);
    setExportQuality(meta.defaultQuality);
    if (nextPreset === "taobao") setStitchDetail(true);
  };

  const handleDownloadSingle = async (slot: ResolvedDeliverySlot) => {
    if (!slot.previewUrl) return;
    try {
      const response = await fetch(slot.previewUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("单张下载失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = slot.exportFilename ?? `${slot.title}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      onNotify(`已下载 ${slot.exportFilename ?? slot.title}`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "单张下载失败");
    }
  };

  const handleExportZip = async () => {
    if (!deliverableSlots.length || exporting) return;
    setExporting(true);
    try {
      const exportUrl = suiteApi.deliveryExportUrl(workbench.suite.id, {
        preset: exportPreset,
        format: exportFormat,
        quality: exportFormat === "jpeg" || exportFormat === "webp" ? exportQuality : undefined,
        stitchDetail: stitchDetail && deliverableDetails.length > 0,
      });
      const response = await fetch(exportUrl, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "导出 ZIP 失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const suffix = exportPreset === "original" ? "delivery" : `delivery_${exportPreset}`;
      anchor.download = `${workbench.suite.name}_${suffix}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      onNotify(`已按「${activePresetMeta.label}」导出 ${deliverableSlots.length} 张成品图${stitchDetail && deliverableDetails.length > 0 ? " + 详情无缝长图" : ""}与 manifest.json`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "导出 ZIP 失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="dg-root" aria-label="成品交付视图">
      <div className="dg-main">
        <header className="dg-toolbar">
          <div className="dg-toolbar-copy">
            <strong>成品交付视图</strong>
            <span>只读验收 · 坑位按“编辑终版 → 终版 → 编辑当前版 → 当前版”自动归并</span>
          </div>
          <div className="dg-toolbar-actions">
            {subView === "storefront" && (
              <div className="dg-subview-switch" role="group" aria-label="终端预览模式">
                <button type="button" className={deviceMode === "desktop" ? "is-active" : ""} onClick={() => setDeviceMode("desktop")}>PC 货架</button>
                <button type="button" className={deviceMode === "mobile" ? "is-active" : ""} onClick={() => setDeviceMode("mobile")}>手机端 390px</button>
              </div>
            )}
            <div className="dg-subview-switch" role="tablist" aria-label="交付展示方式">
              <button type="button" role="tab" aria-selected={subView === "storefront"} className={subView === "storefront" ? "is-active" : ""} onClick={() => setSubView("storefront")}>货架仿真预览</button>
              <button type="button" role="tab" aria-selected={subView === "grid"} className={subView === "grid" ? "is-active" : ""} onClick={() => setSubView("grid")}>分组网格清单</button>
            </div>
            <button
              type="button"
              className="dg-export-btn"
              disabled={!deliverableSlots.length || exporting}
              onClick={() => void handleExportZip()}
              title={deliverableSlots.length ? "打包下载归并后的主图、详情图与 manifest.json" : "尚无可交付图片"}
            >
              <Icon name="save" />
              <span>{exporting ? "正在打包 ZIP…" : `一键打包下载 ZIP (${deliverableSlots.length})`}</span>
            </button>
          </div>
        </header>

        {/* 多平台导出规格配置条 */}
        <div className="dg-export-bar" aria-label="多平台导出规格配置">
          <label className="dg-export-field">
            <span>平台规格预设</span>
            <select aria-label="平台规格预设" value={exportPreset} onChange={(event) => handlePresetChange(event.target.value as DeliveryExportPresetId)}>
              {PRESET_LIST.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label className="dg-export-field">
            <span>导出格式</span>
            <select aria-label="导出格式" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as DeliveryExportFormat)}>
              <option value="original">保持原格式</option>
              <option value="jpeg">JPG（体积小，电商推荐）</option>
              <option value="webp">WebP（独立站秒开）</option>
              <option value="png">PNG（无损）</option>
            </select>
          </label>
          {(exportFormat === "jpeg" || exportFormat === "webp") && (
            <label className="dg-export-field dg-quality-field">
              <span>压缩质量 {exportQuality}%</span>
              <input type="range" min={60} max={100} value={exportQuality} onChange={(event) => setExportQuality(Number(event.target.value))} />
            </label>
          )}
          <label className="dg-export-check">
            <input type="checkbox" checked={stitchDetail} disabled={!deliverableDetails.length} onChange={(event) => setStitchDetail(event.target.checked)} />
            <span>同步输出详情无缝长图</span>
          </label>
          <span className="dg-export-hint" title={activePresetMeta.description}>{activePresetMeta.description}</span>
        </div>

        <div className="dg-scroll">
          {subView === "storefront" ? (
            <div className={`dg-storefront ${deviceMode === "mobile" ? "is-mobile" : ""}`}>
              {/* 模拟跨境电商主图轮播区 */}
              <section className="dg-shelf-hero" aria-label="主图轮播预览">
                <div className="dg-shelf-thumbs">
                  {mainSlots.map((slot, index) => (
                    <button
                      type="button"
                      key={slot.parentTaskId}
                      className={`dg-shelf-thumb ${slot.parentTaskId === activeMainSlot?.parentTaskId ? "is-active" : ""}`}
                      onClick={() => { setActiveMainId(slot.parentTaskId); setSelectedSlotKey(slot.parentTaskId); }}
                    >
                      {slot.previewUrl ? <ImageWithState src={slot.previewUrl} alt={slot.title} loading="lazy" retryable={false} /> : <span>#{index + 1}</span>}
                      <em>M{index + 1}</em>
                    </button>
                  ))}
                  {!mainSlots.length && <div className="dg-empty-mini">暂无主图坑位</div>}
                </div>
                <div className="dg-shelf-stage">
                  {activeMainSlot?.previewUrl ? (
                    <button type="button" className="dg-shelf-stage-btn" onClick={() => { setSelectedSlotKey(activeMainSlot.parentTaskId); onPreview(activeMainSlot); }}>
                      <ImageWithState src={activeMainSlot.previewUrl} alt={activeMainSlot.title} loading="eager" retryable={false} />
                      <span className={`dg-role-pill is-${ROLE_LABELS[activeMainSlot.sourceRole].tone}`}>{ROLE_LABELS[activeMainSlot.sourceRole].label}</span>
                    </button>
                  ) : (
                    <div className="dg-stage-placeholder">
                      <Icon name="image" />
                      <strong>{activeMainSlot ? `${activeMainSlot.title} · 尚未生成` : "暂无主图可预览"}</strong>
                      <span>请返回创作板完成主图生成后再验收</span>
                    </div>
                  )}
                </div>
                <div className="dg-shelf-summary">
                  <div className="dg-shelf-top-badges">
                    <span className="dg-kicker">{deviceMode === "mobile" ? "MOBILE STOREFRONT" : "STOREFRONT PREVIEW"}</span>
                    <span className={`dg-score-pill is-${compliance.score >= 85 ? "pass" : compliance.score >= 55 ? "warn" : "fail"}`}>
                      合规预检 {compliance.score} 分
                    </span>
                  </div>
                  <h2>{workbench.suite.name}</h2>
                  <p>{activeMainSlot?.purpose || "通过货架仿真视图审阅跨境商品主图与无缝详情页整体观感。"}</p>
                  <div className="dg-metrics-row">
                    <div><strong>{deliverableSlots.length}/{slots.length}</strong><span>已交付坑位</span></div>
                    <div><strong>{finalCount}</strong><span>已定终版</span></div>
                    <div><strong>{derivedCount}</strong><span>编辑派生</span></div>
                  </div>
                  <div className="dg-style-chip">
                    <strong>当前生效全局风格</strong>
                    <p>{effectiveStyleGuide}</p>
                  </div>
                </div>
              </section>

              {/* 详情页无缝长图拼接预览 */}
              <section className="dg-detail-stream" aria-label="详情页无缝长图预览">
                <header className="dg-section-title">
                  <div>
                    <h3>详情页无缝拼接预览{deviceMode === "mobile" ? "（移动端 390px 模拟）" : ""}</h3>
                    <span>共 {detailSlots.length} 个详情坑位 · 点击任意屏查看对应提示词快照与来源血缘</span>
                  </div>
                </header>
                {detailSlots.length ? (
                  <div className={`dg-long-canvas ${deviceMode === "mobile" ? "is-mobile" : ""}`}>
                    {detailSlots.map((slot, index) => (
                      <article
                        key={slot.parentTaskId}
                        className={`dg-long-slice ${selectedSlot?.parentTaskId === slot.parentTaskId ? "is-selected" : ""}`}
                        onClick={() => setSelectedSlotKey(slot.parentTaskId)}
                      >
                        <div className="dg-slice-bar">
                          <span>详情 #{index + 1} · {slot.title}</span>
                          <div className="dg-slice-tags">
                            <span className={`dg-role-pill is-${ROLE_LABELS[slot.sourceRole].tone}`}>{ROLE_LABELS[slot.sourceRole].label}</span>
                            {slot.previewUrl && <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedSlotKey(slot.parentTaskId); onPreview(slot); }}>放大 / 对比</button>}
                            {slot.previewUrl && <button type="button" onClick={(event) => { event.stopPropagation(); void handleDownloadSingle(slot); }}>下载单张</button>}
                          </div>
                        </div>
                        {slot.previewUrl ? (
                          <img src={slot.previewUrl} alt={slot.title} loading="lazy" />
                        ) : (
                          <div className="dg-slice-empty">待生成：{slot.purpose}</div>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="dg-empty-block">当前方案暂无详情页任务坑位。</div>
                )}
              </section>
            </div>
          ) : (
            /* 分组网格清单 */
            <div className="dg-grid-view">
              {([
                { title: `主图组（${mainSlots.length}）`, subtitle: "归并后每个主图坑位仅保留唯一交付版本", items: mainSlots },
                { title: `详情页组（${detailSlots.length}）`, subtitle: "按顺序导出至 detail/ 目录", items: detailSlots },
              ] as const).map((group) => (
                <section className="dg-group" key={group.title}>
                  <header className="dg-section-title">
                    <div><h3>{group.title}</h3><span>{group.subtitle}</span></div>
                  </header>
                  <div className="dg-cards">
                    {group.items.map((slot) => (
                      <article
                        key={slot.parentTaskId}
                        className={`dg-card ${selectedSlot?.parentTaskId === slot.parentTaskId ? "is-selected" : ""}`}
                        onClick={() => setSelectedSlotKey(slot.parentTaskId)}
                      >
                        <div className="dg-card-media">
                          {slot.previewUrl ? (
                            <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedSlotKey(slot.parentTaskId); onPreview(slot); }}>
                              <ImageWithState src={slot.previewUrl} alt={slot.title} loading="lazy" retryable={false} />
                            </button>
                          ) : <div className="dg-card-empty">待生成</div>}
                          <span className={`dg-role-pill is-${ROLE_LABELS[slot.sourceRole].tone}`}>{ROLE_LABELS[slot.sourceRole].label}</span>
                        </div>
                        <div className="dg-card-body">
                          <strong>{slot.title}</strong>
                          <p>{slot.purpose}</p>
                          <small>{slot.exportPath ?? "未生成，不纳入 ZIP"}</small>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧只读交付验收、合规预检与快照面板 */}
      <aside className="dg-inspector" aria-label="交付坑位只读详情">
        <header className="dg-inspector-head">
          <div>
            <span>DELIVERY MANIFEST · READ ONLY</span>
            <strong>{selectedSlot ? selectedSlot.title : "选择交付坑位"}</strong>
          </div>
          {selectedSlot && <span className={`dg-role-pill is-${ROLE_LABELS[selectedSlot.sourceRole].tone}`}>{ROLE_LABELS[selectedSlot.sourceRole].label}</span>}
        </header>

        <div className="dg-inspector-body">
          {/* 交付合规预检卡片 */}
          <section className="dg-compliance-card" aria-label="平台交付合规预检">
            <div className="dg-compliance-head">
              <strong>交付合规预检（{activePresetMeta.label}）</strong>
              <span className={`dg-score-pill is-${compliance.score >= 85 ? "pass" : compliance.score >= 55 ? "warn" : "fail"}`}>{compliance.score} 分</span>
            </div>
            <ul className="dg-compliance-list">
              {compliance.checks.map((item) => (
                <li key={item.id} className={`is-${item.status}`}>
                  <span>{item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "×"}</span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {selectedSlot ? (
            <>
              {selectedSlot.previewUrl && (
                <div className="dg-inspector-preview-wrap">
                  <button type="button" className="dg-inspector-thumb" onClick={() => onPreview(selectedSlot)}>
                    <img src={selectedSlot.previewUrl} alt={selectedSlot.title} />
                    <span>{selectedSlot.isEditedDerived ? "查看编辑前后卷帘对比" : "放大预览原图"}</span>
                  </button>
                  <button type="button" className="dg-single-download" onClick={() => void handleDownloadSingle(selectedSlot)}>
                    <Icon name="save" />
                    <span>下载当前单张原图</span>
                  </button>
                </div>
              )}
              <dl className="dg-kv">
                <dt>坑位类型</dt><dd>{selectedSlot.imageType === "main" ? `主图 #${selectedSlot.typeOrdinal}` : `详情页 #${selectedSlot.typeOrdinal}`}</dd>
                <dt>交付来源</dt><dd>{ROLE_LABELS[selectedSlot.sourceRole].label}{selectedSlot.isEditedDerived ? "（经编辑子卡派生）" : ""}</dd>
                <dt>导出路径</dt><dd className="mono">{selectedSlot.exportPath ?? "未生成"}</dd>
                <dt>图片规格</dt><dd>{selectedSlot.width && selectedSlot.height ? `${selectedSlot.width} × ${selectedSlot.height}` : "未记录"}</dd>
                <dt>模型与渠道</dt><dd>{[selectedSlot.channelName, selectedSlot.model].filter(Boolean).join(" · ") || "未记录"}</dd>
                <dt>模板版本</dt><dd className="mono">{selectedSlot.templateVersionId ?? "未记录"}</dd>
                <dt>版本号</dt><dd>{selectedSlot.versionNumber ? `v${selectedSlot.versionNumber}` : "—"}</dd>
              </dl>
              <div className="dg-snapshot-box">
                <div className="dg-snapshot-head">
                  <strong>冻结提示词快照（只读）</strong>
                  <button type="button" onClick={() => { navigator.clipboard?.writeText(selectedSlot.promptText); onNotify("提示词快照已复制"); }}>复制</button>
                </div>
                <pre>{selectedSlot.promptText || "暂无提示词快照"}</pre>
              </div>
              <div className="dg-readonly-note">
                <Icon name="check" />
                <span>成品交付视图为只读验收态，不会修改任务状态或版本选择；如需微调请切回顶部“创作板”。</span>
              </div>
            </>
          ) : (
            <div className="dg-inspector-empty">当前方案尚无可展示的交付坑位。</div>
          )}
        </div>
      </aside>
    </section>
  );
}
