import { useId, useState } from "react";
import {
  APLUS_MODULES, APLUS_MODULE_LIMITS, APLUS_PRODUCT_INFO_MAX_LENGTH, APLUS_SIZE_PRESETS, validateAplusSizePresets,
} from "../../../shared/aplus";
import { VISUAL_STYLES, resolveVisualStyle } from "../../../shared/selling-point-layouts";
import { SUPPORTED_OUTPUT_LANGUAGES } from "../../../shared/workbench-delivery";
import type { ApiImage, ApiPlatformProfile } from "../../api/client";
import { ProductCardPickerModal } from "../../components/product-card-picker/ProductCardPickerModal";
import { SelectedProductCardBar } from "../../components/product-card-picker/SelectedProductCardBar";
import { toSelectedProductCardSummary } from "../../components/product-card-picker/types";
import { StudioProductImageUpload } from "../../components/suite-studio/StudioProductImageUpload";
import { InfoTip } from "../../components/ui/InfoTip";
import { Icon } from "../../pages/shared";
import { configForPlatform, toggleSizePreset, type AplusConfig, type AplusDraft } from "./aplus-studio";

const markets = ["美国", "中国", "英国", "德国", "法国", "日本", "其他"];
const productInfoPlaceholder = "1. 产品名称\n2. 核心卖点\n3. 适用人群\n4. 期望场景\n5. 具体参数";
const infoLimit = APLUS_PRODUCT_INFO_MAX_LENGTH;

export function AplusConfigPanel({
  config, profiles, images, busy, blocked, submitting, aiWriting, aiWrite, stale, awaitingConfirmation,
  onChange, onUpload, onUploadError, onRemove, onAiWrite, onUndoAiWrite, onSubmit, onViewPlan,
}: {
  config: AplusConfig;
  profiles: ApiPlatformProfile[];
  images: ApiImage[];
  busy: boolean;
  blocked: string;
  submitting: boolean;
  aiWriting: boolean;
  aiWrite: AplusDraft["aiWrite"];
  stale: boolean;
  awaitingConfirmation: boolean;
  onChange: (config: AplusConfig) => void;
  onUpload: (files: File[]) => void;
  onUploadError: (message: string) => void;
  onRemove: (image: ApiImage) => void;
  onAiWrite: () => void;
  onUndoAiWrite: () => void;
  onSubmit: () => void;
  onViewPlan: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moduleNotice, setModuleNotice] = useState("");
  const infoId = useId();
  const disabledReason = blocked || (
    !images.length ? "请上传至少 1 张商品原图。"
      : (!config.productCard && !config.productInfo.trim()) ? "请选择商品信息卡或填写商品卖点。"
      : !config.modules.length ? "请至少选择 1 个模块。"
      : !config.sizePresets.length ? "请选择详情尺寸。"
      : ""
  );
  const submitText = stale ? "方案已失效，重新规划" : "生成策划方案";
  const profile = profiles.find(({ code }) => code === config.platform);
  const aiWriteDisabledReason = !images.length ? "请先上传商品原图，再使用 AI 帮写。"
    : !profile ? "请选择可用的平台。" : "";
  const sizeOptions = profile?.detailSizePresets.options.filter((option) =>
    validateAplusSizePresets([option], profile.detailSizePresets),
  ) as AplusConfig["sizePresets"] | undefined;

  return (
    <aside className="ss-panel" aria-label="A+详情配置">
      <fieldset className="ss-scroll" disabled={busy}>
        <div className="ss-eyebrow">A+ STUDIO</div>
        <h1>A+详情</h1>
        <StudioProductImageUpload images={images} busy={busy} canUpload upload={onUpload} onUploadError={onUploadError} remove={onRemove} />
        <section>
          <h2>生成设置</h2>
          <div className="ss-fields">
            <label>
              平台
              <select aria-label="平台" value={config.platform} onChange={(event) => {
                const next = profiles.find(({ code }) => code === event.target.value);
                if (next) onChange(configForPlatform(config, next));
              }}>
                {!profile && <option value={config.platform}>{config.platform || "请选择平台"}</option>}
                {profiles.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <label>
              目标市场
              <select aria-label="目标市场" value={config.targetMarket} onChange={(event) => onChange({ ...config, targetMarket: event.target.value })}>
                {Array.from(new Set([...markets, config.targetMarket])).map((market) => <option key={market}>{market}</option>)}
              </select>
            </label>
            <label>
              输出语言
              <select aria-label="输出语言" value={config.language} onChange={(event) => onChange({ ...config, language: event.target.value })}>
                {SUPPORTED_OUTPUT_LANGUAGES.map(({ code, label }) => <option key={code} value={code}>{label}</option>)}
                <option value="none">不加文字</option>
              </select>
            </label>
            <label>
              视觉风格
              <select aria-label="视觉风格" value={config.visualStyle ?? "auto"}
                onChange={(event) => onChange({ ...config, visualStyle: resolveVisualStyle(event.target.value).id })}>
                {VISUAL_STYLES.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="aplus-size-options">
            <legend>详情尺寸</legend>
            {sizeOptions?.map((key) => {
              const preset = APLUS_SIZE_PRESETS[key];
              return (
                <label key={key} className={preset.deliverySize ? "aplus-pixel-size" : undefined}>
                  <input
                    type="checkbox"
                    checked={config.sizePresets.includes(key)}
                    onChange={() => onChange({ ...config, sizePresets: toggleSizePreset(config.sizePresets, key) })}
                  />
                  {preset.name}{preset.deliverySize && <small>{preset.deliverySize.width}×{preset.deliverySize.height}</small>}
                </label>
              );
            })}
            {sizeOptions && sizeOptions.filter((key) => APLUS_SIZE_PRESETS[key].canCombine).length > 1 && (
              <small>高级 A+ 的 Web 端和移动端可同时选择。</small>
            )}
          </fieldset>
          <details className="aplus-resolution">
            <summary>分辨率 · {config.resolution}</summary>
            <div className="ss-fields">
              <label>
                出图分辨率
                <select aria-label="出图分辨率" value={config.resolution} onChange={(event) => onChange({ ...config, resolution: event.target.value === "1K" ? "1K" : "2K" })}>
                  <option value="1K">1K</option>
                  <option value="2K">2K</option>
                </select>
              </label>
            </div>
            {config.sizePresets.includes("aplus_premium_web") && <small>高级 A+（Web 端）固定使用 1K 生成。</small>}
          </details>
        </section>
        <section>
          <h2>商品信息卡 <small>选填</small></h2>
          {config.productCard ? (
            <SelectedProductCardBar
              card={config.productCard}
              onChangeCard={() => setPickerOpen(true)}
              onRemove={() => onChange({ ...config, productCard: null })}
            />
          ) : (
            <div className="pcp-trigger-wrap">
              <button
                type="button"
                className="pcp-trigger-btn"
                aria-haspopup="dialog"
                disabled={busy}
                onClick={() => setPickerOpen(true)}
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
            <h2><label htmlFor={infoId}>{config.productCard ? "补充卖点 & 本次生成要求（选填）" : "商品卖点 & 生成要求"}</label></h2>
            <InfoTip
              label="商品卖点填写说明"
              align="start"
              content={config.productCard
                ? "客观商品事实已由所选商品信息卡自动注入，可在此补充本次画面侧重点、构图色调偏好或额外说明。"
                : "请填写已确认的商品事实，例如产品名称、核心卖点、适用人群、期望场景和具体参数。不确定的信息可留空。"}
            />
            {config.productCard && (
              <button
                type="button"
                className="aplus-ai-write"
                disabled={busy || Boolean(aiWriteDisabledReason)}
                aria-busy={aiWriting}
                aria-describedby={aiWriteDisabledReason ? `${infoId}-ai-write-reason` : undefined}
                onClick={onAiWrite}
              >
                <Icon name="sparkles" />{aiWriting ? "AI 帮写中…" : "AI 帮写"}
              </button>
            )}
          </div>
          <textarea
            id={infoId}
            aria-label="商品卖点与生成要求"
            aria-required={!config.productCard}
            rows={5}
            placeholder={config.productCard
              ? "客观商品事实将由所选商品信息卡自动注入；可在此补充本次画面侧重点、构图色调偏好或额外说明"
              : productInfoPlaceholder}
            value={config.productInfo}
            onChange={(event) => onChange({ ...config, productInfo: Array.from(event.target.value).slice(0, infoLimit).join("") })}
          />
          <div className="aplus-product-info-footer">
            {config.productCard && aiWrite && <button type="button" onClick={onUndoAiWrite}>撤销帮写</button>}
            <small className="aplus-char-count">{Array.from(config.productInfo).length} / {infoLimit}</small>
          </div>
          {config.productCard && aiWriteDisabledReason && <p className="ss-help" id={`${infoId}-ai-write-reason`}>{aiWriteDisabledReason}</p>}
          {config.productCard && aiWrite?.truncated && <p className="ss-help" role="status">AI 帮写结果超过 {infoLimit} 字，已截断。</p>}
        </section>
        <section>
          <div className="aplus-section-heading">
            <h2>包含模块</h2>
            <small>{config.modules.length} / {APLUS_MODULE_LIMITS.max}</small>
          </div>
          <div className="aplus-module-options">
            {APLUS_MODULES.map(({ code, name, description }) => {
              const checked = config.modules.includes(code);
              return (
                <label key={code} className={checked ? "is-selected" : ""}>
                  <input type="checkbox" checked={checked} aria-label={name} onChange={() => {
                    if (!checked && config.modules.length >= APLUS_MODULE_LIMITS.max) {
                      setModuleNotice("最多可选 10 个模块，请先取消一个已选模块。");
                      return;
                    }
                    setModuleNotice("");
                    const modules = checked ? config.modules.filter((item) => item !== code) : [...config.modules, code];
                    onChange({ ...config, modules: APLUS_MODULES.filter((item) => modules.includes(item.code)).map((item) => item.code) });
                  }} />
                  <span><strong>{name}</strong><small>{description}</small></span>
                </label>
              );
            })}
          </div>
          {moduleNotice && <p className="ss-help" role="status">{moduleNotice}</p>}
        </section>
      </fieldset>
      <ProductCardPickerModal
        open={pickerOpen}
        selectedCardId={config.productCard?.cardId ?? null}
        onClose={() => setPickerOpen(false)}
        onConfirm={(card) => onChange({ ...config, productCard: toSelectedProductCardSummary(card) })}
      />
      <footer>
        {disabledReason && <p className="aplus-submit-reason" role="status">{disabledReason}</p>}
        {awaitingConfirmation ? (
          <button type="button" onClick={onViewPlan}>查看方案</button>
        ) : (
          <button className="ss-primary" type="button" disabled={busy || Boolean(disabledReason)} onClick={onSubmit}>
            {submitting ? "正在提交…" : submitText}
          </button>
        )}
      </footer>
    </aside>
  );
}
