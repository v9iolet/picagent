import { useId, useState } from "react";
import {
  APLUS_MODULES, APLUS_MODULE_LIMITS, APLUS_SIZE_PRESETS, validateAplusSizePresets,
} from "../../../shared/aplus";
import { SUPPORTED_OUTPUT_LANGUAGES } from "../../../shared/workbench-delivery";
import type { ApiImage, ApiPlatformProfile } from "../../api/client";
import { ProductCardPickerModal } from "../../components/product-card-picker/ProductCardPickerModal";
import { SelectedProductCardBar } from "../../components/product-card-picker/SelectedProductCardBar";
import { toSelectedProductCardSummary } from "../../components/product-card-picker/types";
import { StudioProductImageUpload } from "../../components/suite-studio/StudioProductImageUpload";
import { Icon } from "../../pages/shared";
import { configForPlatform, toggleSizePreset, type AplusConfig } from "./aplus-studio";

const markets = ["美国", "中国", "英国", "德国", "法国", "日本", "其他"];
const productInfoPlaceholder = "1. 产品名称\n2. 核心卖点\n3. 适用人群\n4. 期望场景\n5. 具体参数";
const infoLimit = 1000;

export function AplusConfigPanel({
  config, profiles, images, busy, blocked, submitting, stale, awaitingConfirmation,
  onChange, onUpload, onRemove, onSubmit, onViewPlan,
}: {
  config: AplusConfig;
  profiles: ApiPlatformProfile[];
  images: ApiImage[];
  busy: boolean;
  blocked: string;
  submitting: boolean;
  stale: boolean;
  awaitingConfirmation: boolean;
  onChange: (config: AplusConfig) => void;
  onUpload: (files: File[]) => void;
  onRemove: (image: ApiImage) => void;
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
  const sizeOptions = profile?.detailSizePresets.options.filter((option) =>
    validateAplusSizePresets([option], profile.detailSizePresets),
  ) as AplusConfig["sizePresets"] | undefined;

  return (
    <aside className="ss-panel" aria-label="A+详情配置">
      <fieldset className="ss-scroll" disabled={busy}>
        <h1>A+详情</h1>
        <StudioProductImageUpload images={images} busy={busy} canUpload upload={onUpload} remove={onRemove} />
        <section>
          <h2>商品信息卡 <small>选填</small></h2>
          {config.productCard ? (
            <SelectedProductCardBar
              card={config.productCard}
              onChangeCard={() => setPickerOpen(true)}
              onRemove={() => onChange({ ...config, productCard: null })}
            />
          ) : (
            <button type="button" onClick={() => setPickerOpen(true)}>选择商品信息卡</button>
          )}
        </section>
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
          <div className="aplus-section-heading">
            <h2><label htmlFor={infoId}>商品卖点&生成要求</label></h2>
            <button type="button" className="aplus-ai-write" disabled title="AI 帮写暂未开放">
              <Icon name="sparkles" />AI 帮写
            </button>
          </div>
          <textarea
            id={infoId}
            rows={5}
            placeholder={productInfoPlaceholder}
            value={config.productInfo}
            onChange={(event) => onChange({ ...config, productInfo: Array.from(event.target.value).slice(0, infoLimit).join("") })}
          />
          <small className="aplus-char-count">{Array.from(config.productInfo).length} / {infoLimit}</small>
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
