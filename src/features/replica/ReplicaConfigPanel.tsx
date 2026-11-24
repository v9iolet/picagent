import { useId, useState, type DragEvent } from "react";
import type { ImageOptions } from "../../../shared/model-settings";
import { ProductCardPickerModal } from "../../components/product-card-picker/ProductCardPickerModal";
import { SelectedProductCardBar } from "../../components/product-card-picker/SelectedProductCardBar";
import { toSelectedProductCardSummary } from "../../components/product-card-picker/types";
import { InfoTip } from "../../components/ui/InfoTip";
import { Icon } from "../../pages/shared";
import {
  allowedReplicaSizes,
  charCount,
  getReplicaSubmitState,
  needsNoProductWarning,
  REPLICA_CLONE_LEVEL_OPTIONS,
  REPLICA_LANGUAGE_OPTIONS,
  REPLICA_MAX_PRODUCTS,
  REPLICA_MAX_REFERENCES,
  REPLICA_REMARK_MAX_LENGTH,
  REPLICA_SCENE_OPTIONS,
  REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH,
  type ReplicaConfigDraft,
  type ReplicaProductDraft,
  type ReplicaReferenceDraft,
} from "./replica-types";

export interface ReplicaConfigPanelProps {
  references: ReplicaReferenceDraft[];
  products: ReplicaProductDraft[];
  config: ReplicaConfigDraft;
  imageOptions: ImageOptions;
  submitting: boolean;
  refNotice: string;
  productNotice: string;
  onAddReferences: (files: File[]) => void;
  onRemoveReference: (localId: string) => void;
  onMoveReference: (fromIndex: number, toIndex: number) => void;
  onUpdateReferenceRemark: (localId: string, remark: string) => void;
  onAddProductFiles: (files: File[]) => void;
  onRemoveProduct: (localId: string) => void;
  onMoveProduct: (fromIndex: number, toIndex: number) => void;
  onUpdateConfig: (patch: Partial<ReplicaConfigDraft>) => void;
  onSubmit: () => void;
}

export function ReplicaConfigPanel({
  references,
  products,
  config,
  imageOptions,
  submitting,
  refNotice,
  productNotice,
  onAddReferences,
  onRemoveReference,
  onMoveReference,
  onUpdateReferenceRemark,
  onAddProductFiles,
  onRemoveProduct,
  onMoveProduct,
  onUpdateConfig,
  onSubmit,
}: ReplicaConfigPanelProps) {
  const [refDragging, setRefDragging] = useState(false);
  const [productDragging, setProductDragging] = useState(false);
  const [dragRefIndex, setDragRefIndex] = useState<number | null>(null);
  const [hoveredLevel, setHoveredLevel] = useState<string | null>(null);
  const [productCardPickerOpen, setProductCardPickerOpen] = useState(false);
  const styleUnifiedId = useId();

  const validRefCount = references.filter((item) => item.status === "ready").length;
  const validProductCount = products.filter((item) => item.status === "ready").length;
  const sizes = allowedReplicaSizes(imageOptions);
  const showStyleUnified = validRefCount >= 2;
  const showNoProductWarning = needsNoProductWarning(config.sceneType, validProductCount);
  const submitState = getReplicaSubmitState(references, products, config, submitting);
  const unifiedCount = charCount(config.unifiedRequirement);
  const hasProductCard = Boolean(config.productCardId && config.productCardSummary);

  const handleRefCardDrop = (targetIndex: number) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (dragRefIndex === null || dragRefIndex === targetIndex) {
      setDragRefIndex(null);
      return;
    }
    onMoveReference(dragRefIndex, targetIndex);
    setDragRefIndex(null);
  };

  return (
    <aside className="ss-panel rp-config-panel" aria-label="复刻配置">
      <fieldset className="ss-scroll" disabled={submitting}>
        <div className="ss-eyebrow">PRODUCT REPLICA</div>
        <h1>爆品图复刻</h1>

        <section>
          <h2>
            参考图 <small>{references.length} / {REPLICA_MAX_REFERENCES}</small>
          </h2>
          <div
            className={`rp-dropzone${refDragging ? " dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setRefDragging(true);
            }}
            onDragLeave={() => setRefDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setRefDragging(false);
              if (!submitting && event.dataTransfer.files.length) {
                onAddReferences(Array.from(event.dataTransfer.files));
              }
            }}
          >
            <label className={`rp-upload-trigger${references.length >= REPLICA_MAX_REFERENCES ? " is-full" : ""}`}>
              <span>＋ 上传参考图（支持拖拽或多选，1–6 张）</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="上传参考图"
                multiple
                disabled={submitting || references.length >= REPLICA_MAX_REFERENCES}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length) onAddReferences(files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="rp-auth-hint">
            请确认已获得参考图的合法使用授权；品牌、Logo、参数等不会被复刻
          </p>
          {refNotice && (
            <p className="rp-inline-notice" role="status">
              {refNotice}
            </p>
          )}
          {references.length > 0 && (
            <ol className="rp-ref-list" aria-label="已上传参考图">
              {references.map((item, index) => {
                const remarkLen = charCount(item.remark);
                const overLimit = remarkLen > REPLICA_REMARK_MAX_LENGTH;
                return (
                  <li
                    key={item.localId}
                    className={`rp-ref-item${item.status === "error" ? " is-error" : ""}`}
                    draggable={!submitting}
                    onDragStart={() => setDragRefIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={handleRefCardDrop(index)}
                    onDragEnd={() => setDragRefIndex(null)}
                    data-ref-item
                  >
                    <div className="rp-ref-thumb-wrap">
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt={item.filename} />
                      ) : (
                        <span className="rp-ref-fallback">{item.status === "reading" ? "…" : "!"}</span>
                      )}
                      <span className="rp-ordinal">{index + 1}</span>
                    </div>
                    <div className="rp-ref-body">
                      <div className="rp-ref-top">
                        <strong title={item.filename}>{item.filename}</strong>
                        <div className="rp-item-ops">
                          <button
                            type="button"
                            aria-label={`上移参考图 ${index + 1}`}
                            disabled={index === 0}
                            onClick={() => onMoveReference(index, index - 1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`下移参考图 ${index + 1}`}
                            disabled={index === references.length - 1}
                            onClick={() => onMoveReference(index, index + 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label={`移除参考图 ${item.filename}`}
                            onClick={() => onRemoveReference(item.localId)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      {item.status === "reading" ? (
                        <small className="rp-status-text">正在读取图片…</small>
                      ) : item.status === "error" ? (
                        <small className="rp-error-text" role="alert">
                          {item.error ?? "图片处理失败"}
                        </small>
                      ) : (
                        <div className="rp-remark-wrap">
                          <input
                            type="text"
                            className={overLimit ? "is-invalid" : undefined}
                            aria-label={`单张参考要求 ${index + 1}`}
                            maxLength={REPLICA_REMARK_MAX_LENGTH}
                            placeholder="单张参考要求（选填，≤200字）"
                            value={item.remark}
                            onChange={(event) => onUpdateReferenceRemark(item.localId, event.target.value)}
                          />
                          <small className={overLimit ? "rp-char-count rp-error-text" : "rp-char-count"}>
                            {remarkLen}/{REPLICA_REMARK_MAX_LENGTH}
                          </small>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section>
          <h2>
            产品原图（选填） <small>{products.length} / {REPLICA_MAX_PRODUCTS}</small>
          </h2>
          <div
            className={`ss-upload rp-product-upload${productDragging ? " dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setProductDragging(true);
            }}
            onDragLeave={() => setProductDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setProductDragging(false);
              if (!submitting && event.dataTransfer.files.length) {
                onAddProductFiles(Array.from(event.dataTransfer.files));
              }
            }}
          >
            {products.map((item, index) => {
              const title = item.filename;
              return (
                <div
                  className={`ss-thumb rp-product-thumb${item.status === "error" ? " is-error" : ""}`}
                  key={item.localId}
                  data-product-item
                >
                  {item.previewUrl ? (
                    <img alt={title} src={item.previewUrl} />
                  ) : (
                    <span className="rp-ref-fallback">{item.status === "reading" ? "…" : "!"}</span>
                  )}
                  <span className="rp-product-source">本地</span>
                  <div className="rp-product-controls">
                    {index > 0 && (
                      <button
                        type="button"
                        aria-label={`左移产品图 ${title}`}
                        onClick={() => onMoveProduct(index, index - 1)}
                      >
                        ←
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`移除产品图 ${title}`}
                      onClick={() => onRemoveProduct(item.localId)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            {products.length < REPLICA_MAX_PRODUCTS && (
              <label className="ss-add">
                <b>＋</b>上传产品图
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="上传产品原图"
                  multiple
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length) onAddProductFiles(files);
                    event.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          <div className="rp-product-bar">
            <small>同一商品多角度，本地拖拽或点击上传，整批共用（最多 6 张）</small>
          </div>
          {productNotice && (
            <p className="rp-inline-notice" role="status">
              {productNotice}
            </p>
          )}
          {showNoProductWarning && (
            <div className="rp-warn-banner" role="alert">
              未上传产品图，结果仅作风格示意
            </div>
          )}
        </section>

        <section>
          <h2>复刻类型</h2>
          <div className="rp-scene-grid" role="radiogroup" aria-label="复刻类型">
            {REPLICA_SCENE_OPTIONS.map((option) => {
              const checked = config.sceneType === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  className={`rp-pill${checked ? " is-active" : ""}`}
                  onClick={() => onUpdateConfig({ sceneType: option.value })}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h2>复刻程度</h2>
          <div className="rp-level-grid" role="radiogroup" aria-label="复刻程度">
            {REPLICA_CLONE_LEVEL_OPTIONS.map((option) => {
              const checked = config.cloneLevel === option.value;
              const showingTip = hoveredLevel === option.value;
              return (
                <div
                  key={option.value}
                  className="rp-level-wrap"
                  onMouseEnter={() => setHoveredLevel(option.value)}
                  onMouseLeave={() => setHoveredLevel((cur) => (cur === option.value ? null : cur))}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className={`rp-level-card${checked ? " is-active" : ""}`}
                    onFocus={() => setHoveredLevel(option.value)}
                    onBlur={() => setHoveredLevel((cur) => (cur === option.value ? null : cur))}
                    onClick={() => onUpdateConfig({ cloneLevel: option.value })}
                  >
                    <strong>{option.label}</strong>
                    <small>{option.shortDesc}</small>
                  </button>
                  <div
                    className={`rp-level-popover${showingTip ? " is-visible" : ""}`}
                    role="tooltip"
                    aria-hidden={!showingTip}
                  >
                    <img src={option.previewImage} alt={`${option.label}示意图`} />
                    <strong>{option.hoverTitle}</strong>
                    <p>{option.hoverDesc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <div className="rp-heading-row">
            <h2>统一复刻要求（选填）</h2>
            <small className={unifiedCount > REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH ? "rp-error-text" : undefined}>
              {unifiedCount} / {REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH}
            </small>
          </div>
          <textarea
            rows={3}
            aria-label="统一复刻要求"
            maxLength={REPLICA_UNIFIED_REQUIREMENT_MAX_LENGTH}
            placeholder="例如：保持参考图版式、只替换商品"
            value={config.unifiedRequirement}
            onChange={(event) => onUpdateConfig({ unifiedRequirement: event.target.value })}
          />
        </section>

        <section>
          {hasProductCard && config.productCardSummary ? (
            <SelectedProductCardBar
              card={config.productCardSummary}
              disabled={submitting}
              onChangeCard={() => setProductCardPickerOpen(true)}
              onRemove={() =>
                onUpdateConfig({
                  productCardId: null,
                  productCardSummary: null,
                })
              }
            />
          ) : (
            <div className="pcp-trigger-wrap">
              <button
                type="button"
                className="pcp-trigger-btn"
                aria-haspopup="dialog"
                disabled={submitting}
                onClick={() => setProductCardPickerOpen(true)}
              >
                <span className="pcp-trigger-left">
                  <Icon name="box" />
                  <span>选择商品信息卡（选填）</span>
                </span>
                <span className="pcp-trigger-arrow" aria-hidden="true">›</span>
              </button>
            </div>
          )}
          <div className="rp-heading-with-tip">
            <h2>{hasProductCard ? "补充商品信息（选填）" : "商品信息（选填）"}</h2>
            <InfoTip
              label="事实来源说明"
              title="商品事实来源"
              align="start"
              content={
                hasProductCard
                  ? "客观商品事实由所选商品信息卡自动注入，并与此处补充说明合并作为本批次唯一事实来源。"
                  : "作为本批次新文案中参数、卖点、规格的唯一事实来源，未填写的参数不会编造。"
              }
            />
          </div>
          <textarea
            rows={3}
            aria-label="商品信息"
            placeholder={
              hasProductCard
                ? "客观商品事实将由所选商品信息卡自动注入；可在此补充本次复刻特有的文案或卖点说明"
                : "填写商品名称、核心卖点、参数、规格等真实事实"
            }
            value={config.productInfo}
            onChange={(event) => onUpdateConfig({ productInfo: event.target.value })}
          />
        </section>

        {showStyleUnified && (
          <section>
            <div className="rp-style-switch-row">
              <span className="rp-style-switch-label">
                <label htmlFor={styleUnifiedId}>输出风格保持一致</label>
                <InfoTip
                  label="风格统一说明"
                  title="多图统一调性"
                  align="start"
                  content="开启后整组参考图共享统一的配色与视觉调性。"
                />
              </span>
              <label className="ss-switch rp-style-switch">
                <input
                  id={styleUnifiedId}
                  type="checkbox"
                  aria-label="输出风格保持一致"
                  checked={config.styleUnified}
                  onChange={(event) => onUpdateConfig({ styleUnified: event.target.checked })}
                />
              </label>
            </div>
          </section>
        )}

        <section>
          <h2>生成设置</h2>
          <div className="ss-fields">
            <label>
              输出语言
              <select
                aria-label="输出语言"
                value={config.language}
                onChange={(event) =>
                  onUpdateConfig({ language: event.target.value as ReplicaConfigDraft["language"] })
                }
              >
                {REPLICA_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              比例
              <select
                aria-label="比例"
                value={config.ratio}
                onChange={(event) => onUpdateConfig({ ratio: event.target.value })}
              >
                <option value="reference">参考图比例</option>
                {imageOptions.aspectRatios.map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                  </option>
                ))}
              </select>
            </label>
            <label>
              分辨率
              <select
                aria-label="分辨率"
                value={config.size}
                onChange={(event) => onUpdateConfig({ size: event.target.value })}
              >
                {sizes.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      </fieldset>

      <ProductCardPickerModal
        open={productCardPickerOpen}
        selectedCardId={config.productCardId}
        onClose={() => setProductCardPickerOpen(false)}
        onConfirm={(card) =>
          onUpdateConfig({
            productCardId: card.id,
            productCardSummary: toSelectedProductCardSummary(card),
          })
        }
      />

      <footer className="rp-footer">
        {submitState.disabledReason && (
          <p className="rp-submit-reason" data-submit-reason role="status">
            {submitState.disabledReason}
          </p>
        )}
        <button
          type="button"
          className="ss-primary"
          disabled={!submitState.canSubmit}
          onClick={onSubmit}
        >
          {submitState.buttonLabel}
        </button>
      </footer>
    </aside>
  );
}
