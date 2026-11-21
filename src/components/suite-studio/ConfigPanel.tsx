import { useState } from "react";
import type { ApiImage, ApiPlatformProfile } from "../../api/client";
import type { ImageOptions } from "../../../shared/model-settings";
import {
  SUITE_CATEGORY_GROUPS,
  SUITE_IMAGE_LIMITS,
  type SuiteCategoryGroupCode,
} from "../../../shared/suite-categories";
import { refinement, totalImages, type Config } from "./studio";

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
  const profile = platforms.find((p) => p.code === c.platform),
    policy = refinement(profile, c.refineBaseImages);
  const count = totalImages(c);
  function select(
    label: string,
    key: "targetMarket" | "outputLanguage" | "aspectRatio" | "size",
    choices: string[],
  ) {
    return (
      <label>
        {label}
        <select aria-label={label} value={c[key]} onChange={(e) => update({ [key]: e.target.value })}>
          {choices.map((v) => (
            <option key={v}>{v}</option>
          ))}
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
            {select("语言", "outputLanguage", ["中文", "英语", "日语", "德语", "法语", "西班牙语"])}
            {select("比例", "aspectRatio", options.aspectRatios)}
            {select("分辨率", "size", options.sizes)}
          </div>
          {c.size === "4K" && <p className="ss-note">4K 出图更慢，费用更贵。</p>}
          <label className="ss-switch">
            <span>白底精修</span>
            <input
              type="checkbox"
              aria-label="白底精修"
              checked={policy.enabled}
              disabled={policy.locked}
              onChange={(e) => update({ refineBaseImages: e.target.checked })}
            />
          </label>
          <small>
            {policy.locked
              ? `${profile?.name} 要求纯白背景，精修已锁定。`
              : profile?.mainImageBackground === "white_preferred"
                ? "平台优先使用白底图，可关闭精修。"
                : "平台允许场景背景，可按需开启精修。"}
          </small>
        </section>
        <section>
          <label>
            <h2>商品卖点 & 生成要求</h2>
            <textarea
              rows={3}
              aria-label="商品卖点与生成要求"
              placeholder="输入产品名称、核心卖点、适用场景及已确认的参数…"
              value={c.sellingPoints}
              onChange={(e) => update({ sellingPoints: e.target.value })}
            />
          </label>
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
                name = key === "main" ? policy.mainName : key === "other" ? "其他" : group.name;
              const value = c.counts[key];
              const max =
                key === "main"
                  ? SUITE_IMAGE_LIMITS.main.max
                  : key === "other"
                    ? group.categories.length
                    : SUITE_IMAGE_LIMITS.detail.max;
              const step = (delta: number) => update({ counts: { ...c.counts, [key]: value + delta } });
              return (
                <div key={key} className="ss-counter">
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
      <footer>
        <button className="ss-primary" disabled={busy || !images.length || !profile} onClick={generate}>
          {c.listingCopy ? "一键生成套图与商品上架文案" : "一键生成套图"}（{count}张）
        </button>
      </footer>
    </aside>
  );
}
