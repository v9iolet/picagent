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
import { totalImages, type Config } from "./studio";
import { SellingPointLayoutModal } from "./SellingPointLayoutModal";

const sellingPointsPlaceholder = `建议包含以下信息生成更精准：
1.产品名称
2.核心卖点
3.适用人群
4.期望场景
5.具体参数`;

interface Props {
  config: Config;
  update: (patch: Partial<Config>) => void;
  platforms: ApiPlatformProfile[];
  options: ImageOptions;
  images: ApiImage[];
  busy: boolean;
  canUpload: boolean;
  upload: (files: File[]) => void;
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
  remove,
  generate,
}: Props) {
  const [drag, setDrag] = useState(false);
  const [showSellingPointsHelp, setShowSellingPointsHelp] = useState(false);
  const [showLayouts, setShowLayouts] = useState(false);
  const sellingPointsHelpId = useId();
  const layoutsHelpId = useId();
  const layoutCountId = useId();
  const layoutEntry = useRef<HTMLButtonElement>(null);
  const profile = platforms.find((p) => p.code === c.platform);
  const pureWhiteMain = requiresPureWhiteMainImage(profile);
  const count = totalImages(c);
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
        <section>
          <h2>
            商品原图 <small>{images.length} / 6</small>
          </h2>
          <div
            className={"ss-upload" + (drag ? " dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (canUpload && !busy) upload(Array.from(e.dataTransfer.files));
            }}
          >
            {images.map((im) => (
              <div className="ss-thumb" key={im.id}>
                <img alt={im.originalFilename} src={im.thumbnailPreviewUrl} />
                <button type="button" aria-label={"移除 " + im.originalFilename} onClick={() => remove(im)}>
                  ×
                </button>
              </div>
            ))}
            {images.length < 6 && canUpload && (
              <label className="ss-add">
                <b>＋</b>上传原图
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="上传商品原图"
                  multiple
                  onChange={(e) => {
                    upload(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
          <small>
            {canUpload
              ? "点击或拖入商品实拍图，最多 6 张"
              : "当前为历史批次原图；可移除后按所选原图生成新批次。"}
          </small>
        </section>
        <section>
          <h2>生成设置</h2>
          <div className="ss-fields">
            <label>
              平台
              <select
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
            </label>
            {select("目标市场", "targetMarket", ["美国", "中国", "英国", "德国", "法国", "日本", "其他"])}
            {select("语言", "outputLanguage", SUPPORTED_OUTPUT_LANGUAGES)}
            {select("比例", "aspectRatio", options.aspectRatios)}
            {select("分辨率", "size", options.sizes)}
            {select("视觉风格", "visualStyle", VISUAL_STYLES.map(({ id, name }) => ({ value: id, label: name })))}
          </div>
          <ResolutionCostNote size={c.size} className="ss-note" />
          {profile && (
            <small>
              {pureWhiteMain
                ? "国际站主图将按纯白背景规范生成，数量以主图配置为准。"
                : "国内站主图按场景策略生成，不强制白底。"}
            </small>
          )}
        </section>
        <section>
          <div className="ss-selling-points-heading">
            <h2>商品卖点 & 生成要求</h2>
            <button
              type="button"
              aria-label="商品卖点填写说明"
              aria-expanded={showSellingPointsHelp}
              aria-controls={sellingPointsHelpId}
              onClick={() => setShowSellingPointsHelp((open) => !open)}
            >
              ?
            </button>
          </div>
          <p id={sellingPointsHelpId} className="ss-note" hidden={!showSellingPointsHelp}>
            建议逐行填写产品名称、核心卖点、适用人群、期望场景和具体参数。请填写已确认的商品事实，不确定的信息可留空。
          </p>
          <textarea
            rows={6}
            aria-label="商品卖点与生成要求"
            aria-describedby={showSellingPointsHelp ? sellingPointsHelpId : undefined}
            placeholder={sellingPointsPlaceholder}
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
          <small>根据所选平台规范，智能生成符合上架要求的商品文案</small>
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
      <footer>
        <button className="ss-primary" disabled={busy || !images.length || !profile} onClick={generate}>
          {c.listingCopy ? "一键生成套图与商品上架文案" : "一键生成套图"}（{count}张）
        </button>
      </footer>
    </aside>
  );
}
