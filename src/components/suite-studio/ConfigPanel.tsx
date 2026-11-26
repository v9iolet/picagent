import { ResolutionCostNote } from "../ResolutionCostNote";
import { Fragment, useId, useRef, useState } from "react";
import type { ApiImage, ApiPlatformProfile } from "../../api/client";
import type { ImageOptions } from "../../../shared/model-settings";
import {
  SUITE_CATEGORY_GROUPS,
  SUITE_IMAGE_LIMITS,
  type SuiteCategoryGroupCode,
} from "../../../shared/suite-categories";
import { SUPPORTED_OUTPUT_LANGUAGES } from "../../../shared/workbench-delivery";
import { requiresPureWhiteMainImage } from "../../../shared/platform-main-background";
import { VISUAL_STYLES } from "../../../shared/selling-point-layouts";
import { Icon } from "../../pages/shared";
import { ProductCardPickerModal } from "../product-card-picker/ProductCardPickerModal";
import { SelectedProductCardBar } from "../product-card-picker/SelectedProductCardBar";
import { toSelectedProductCardSummary } from "../product-card-picker/types";
import { StudioProductImageUpload } from "./StudioProductImageUpload";
import { InfoTip } from "../ui/InfoTip";
import { totalImages, type Config } from "./studio";
import { SellingPointLayoutModal } from "./SellingPointLayoutModal";

const sellingPointsPlaceholder = `建议包含以下信息生成更精准：
1.产品名称
2.核心卖点
3.适用人群
4.期望场景
5.具体参数`;

const supplementalSellingPointsPlaceholder =
  "客观商品事实将由所选商品信息卡自动注入；可在此补充本次画面侧重点、构图色调偏好或额外说明";

interface Props {
  config: Config;
  update: (patch: Partial<Config>) => void;
  platforms: ApiPlatformProfile[];
  options: ImageOptions;
  images: ApiImage[];
  busy: boolean;
  canUpload: boolean;
  upload: (files: File[]) => void;
  onUploadError: (message: string) => void;
  remove: (image: ApiImage) => void;
  generate: () => void;
}
export function ConfigPanel({
  config: c,
  update,
  platforms,
  options,
  images,
  busy,
  canUpload,
  upload,
  onUploadError,
  remove,
  generate,
}: Props) {
  const [showLayouts, setShowLayouts] = useState(false);
  const [showProductCardPicker, setShowProductCardPicker] = useState(false);
  const platformSelectId = useId();
  const sellingPointsHelpId = useId();
  const layoutsHelpId = useId();
  const layoutCountId = useId();
  const layoutEntry = useRef<HTMLButtonElement>(null);
  const profile = platforms.find((p) => p.code === c.platform);
  const pureWhiteMain = requiresPureWhiteMainImage(profile);
  const count = totalImages(c);
  const hasProductCard = Boolean(c.productCardId && c.productCardSummary);
  function closeLayouts() {
    setShowLayouts(false);
    requestAnimationFrame(() => layoutEntry.current?.focus({ preventScroll: true }));
  }
  function select(
    label: string,
    key: "targetMarket" | "outputLanguage" | "aspectRatio" | "size" | "visualStyle",
    choices: readonly (string | { value: string; label: string })[],
  ) {
    return (
      <label>
        {label}
        <select aria-label={label} value={c[key]} onChange={(e) => update({ [key]: e.target.value })}>
          {choices.map((choice) => {
            const { value, label } = typeof choice === "string" ? { value: choice, label: choice } : choice;
            return <option key={value} value={value}>{label}</option>;
          })}
        </select>
      </label>
    );
  }
  return (
    <aside className="ss-panel" aria-label="套图配置">
      <fieldset className="ss-scroll" disabled={busy}>
        <div className="ss-eyebrow">SUITE STUDIO</div>
        <h1>商品套图</h1>
        <StudioProductImageUpload images={images} busy={busy} canUpload={canUpload} upload={upload} onUploadError={onUploadError} remove={remove} />
        <section>
          <h2>生成设置</h2>
          <div className="ss-fields">
            <div className="ss-field-wrap">
              <div className="ss-field-head">
                <label htmlFor={platformSelectId}>平台</label>
                {profile && (
                  <InfoTip
                    label="主图背景规范说明"
                    title="平台主图规范"
                    align="start"
                    content={
                      pureWhiteMain
                        ? "国际站主图将按纯白背景规范生成，数量以主图配置为准。"
                        : "国内站主图按场景策略生成，不强制白底。"
                    }
                  />
                )}
              </div>
              <select
                id={platformSelectId}
                aria-label="平台"
                value={c.platform}
                onChange={(e) => update({ platform: e.target.value })}
              >
                {platforms.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            {select("目标市场", "targetMarket", ["美国", "中国", "英国", "德国", "法国", "日本", "其他"])}
            {select("语言", "outputLanguage", SUPPORTED_OUTPUT_LANGUAGES)}
            {select("比例", "aspectRatio", options.aspectRatios)}
            {select("分辨率", "size", options.sizes)}
            {select("视觉风格", "visualStyle", VISUAL_STYLES.map(({ id, name }) => ({ value: id, label: name })))}
          </div>
          <ResolutionCostNote size={c.size} className="ss-note" />
        </section>
        <section>
          {hasProductCard && c.productCardSummary ? (
            <SelectedProductCardBar
              card={c.productCardSummary}
              disabled={busy}
              onChangeCard={() => setShowProductCardPicker(true)}
              onRemove={() =>
                update({
                  productCardId: null,
                  productCardSummary: null,
                  productCardSnapshot: null,
                })
              }
            />
          ) : (
            <div className="pcp-trigger-wrap">
              <button
                type="button"
                className="pcp-trigger-btn"
                aria-haspopup="dialog"
                disabled={busy}
                onClick={() => setShowProductCardPicker(true)}
              >
                <span className="pcp-trigger-left">
                  <Icon name="box" />
                  <span>选择商品信息卡（选填）</span>
                </span>
                <span className="pcp-trigger-arrow" aria-hidden="true">›</span>
              </button>
            </div>
          )}
          <div className="ss-selling-points-heading">
            <h2>{hasProductCard ? "补充卖点 & 本次生成要求（选填）" : "商品卖点 & 生成要求"}</h2>
            <InfoTip
              id={sellingPointsHelpId}
              label="商品卖点填写说明"
              title={hasProductCard ? "商品卡自动注入说明" : "填写说明"}
              align="start"
              content={
                hasProductCard
                  ? "客观商品事实已由所选商品信息卡自动注入；此处仅填写本次画面的侧重点、构图色调偏好或额外说明。"
                  : "建议逐行填写产品名称、核心卖点、适用人群、期望场景和具体参数。请填写已确认的商品事实，不确定的信息可留空。"
              }
            />
          </div>
          <textarea
            rows={6}
            aria-label="商品卖点与生成要求"
            placeholder={hasProductCard ? supplementalSellingPointsPlaceholder : sellingPointsPlaceholder}
            value={c.sellingPoints}
            onChange={(e) => update({ sellingPoints: e.target.value })}
          />
        </section>
        <section>
          <h2>套图结构配置</h2>
          <div className="ss-segments">
            {(["smart", "custom"] as const).map((mode) => (
              <button key={mode} aria-pressed={c.mode === mode} onClick={() => update({ mode })}>
                {mode === "smart" ? "智能匹配" : "自定义配置"}
              </button>
            ))}
          </div>
          {c.mode === "smart" ? (
            <p className="ss-help">根据商品原图与可用事实，智能规划主图及最多 6 张详情图。</p>
          ) : (
            (Object.keys(SUITE_CATEGORY_GROUPS) as SuiteCategoryGroupCode[]).map((key) => {
              const group = SUITE_CATEGORY_GROUPS[key],
                name = key === "main" && pureWhiteMain ? SUITE_CATEGORY_GROUPS.main.whiteName : key === "other" ? "其他" : group.name;
              const value = c.counts[key];
              const max =
                key === "main"
                  ? SUITE_IMAGE_LIMITS.main.max
                  : key === "other"
                    ? group.categories.length
                    : SUITE_IMAGE_LIMITS.detail.max;
              const step = (delta: number) => {
                const nextCount = value + delta;
                update({
                  counts: { ...c.counts, [key]: nextCount },
                  ...(key === "selling_points" && nextCount < c.sellingPointLayouts.length && {
                    sellingPointLayouts: c.sellingPointLayouts.slice(0, nextCount),
                  }),
                });
              };
              return (
                <Fragment key={key}>
                  <div className="ss-counter">
                    <div>
                      <strong>{name}</strong>
                      {key === "other" && <em>AI智能匹配</em>}
                      <small>
                        {group.description}
                        {key === "other" ? "，张数为上限。" : ""}
                      </small>
                    </div>
                    <div className="ss-stepper">
                      <button
                        aria-label={"减少" + name}
                        disabled={value <= (key === "main" ? 1 : 0)}
                        onClick={() => step(-1)}
                      >
                        −
                      </button>
                      <output aria-label={name + "张数"}>{value}</output>
                      <button
                        aria-label={"增加" + name}
                        disabled={
                          value >= max ||
                          count >= SUITE_IMAGE_LIMITS.total.max ||
                          (key !== "main" && count - c.counts.main >= SUITE_IMAGE_LIMITS.detail.max)
                        }
                        onClick={() => step(1)}
                      >
                        ＋
                      </button>
                    </div>
                  </div>
                  {key === "selling_points" && (
                    <button
                      type="button"
                      ref={layoutEntry}
                      className="ss-layout-entry"
                      aria-label="选择卖点图版式参考"
                      aria-describedby={c.sellingPointLayouts.length ? `${layoutsHelpId} ${layoutCountId}` : layoutsHelpId}
                      aria-haspopup="dialog"
                      disabled={value === 0}
                      onClick={() => setShowLayouts(true)}
                    >
                      <span className="ss-layout-entry-icon" aria-hidden="true">?</span>
                      <span>
                        <strong>选择卖点图版式参考</strong>
                        <small id={layoutsHelpId}>每种版式用于一张卖点图</small>
                      </span>
                      {c.sellingPointLayouts.length > 0 && (
                        <span id={layoutCountId} className="ss-layout-entry-badge">已选 {c.sellingPointLayouts.length} 个版式</span>
                      )}
                      <span className="ss-layout-entry-arrow" aria-hidden="true">›</span>
                    </button>
                  )}
                </Fragment>
              );
            })
          )}
        </section>
        <section>
          <h2>附加功能</h2>
          <label className="ss-switch">
            商品上架文案生成
            <input
              type="checkbox"
              checked={c.listingCopy}
              onChange={(e) => update({ listingCopy: e.target.checked })}
            />
          </label>
        </section>
      </fieldset>
      {showLayouts && (
        <SellingPointLayoutModal
          selectedIds={c.sellingPointLayouts}
          maxCount={c.counts.selling_points}
          close={closeLayouts}
          apply={(sellingPointLayouts) => {
            update({ sellingPointLayouts });
            closeLayouts();
          }}
        />
      )}
      <ProductCardPickerModal
        open={showProductCardPicker}
        selectedCardId={c.productCardId}
        onClose={() => setShowProductCardPicker(false)}
        onConfirm={(card) =>
          update({
            productCardId: card.id,
            productCardSummary: toSelectedProductCardSummary(card),
            productCardSnapshot: null,
          })
        }
      />
      <footer>
        <button className="ss-primary" disabled={busy || !images.length || !profile} onClick={generate}>
          {c.listingCopy ? "一键生成套图与商品上架文案" : "一键生成套图"}（{count}张）
        </button>
      </footer>
    </aside>
  );
}
