import { ResolutionCostNote } from "./ResolutionCostNote";
import { useState, type FormEvent } from "react";
import type { ApiImage } from "../api/client";
import type { ImageOptions } from "../../shared/model-settings";
import { Drawer } from "./ui/Drawer";

const QUICK_SCENES = [
  { label: "纯白底合规主图", imageType: "main" as const, ratio: "1:1", title: "纯白底标准主图", prompt: "纯白 #FFFFFF 影棚背景，商品居中占画幅约 85%，自然微弱接触阴影，清晰展示商品真实轮廓与材质细节，无任何多余装饰与文字。" },
  { label: "居家生活场景图", imageType: "detail" as const, ratio: "3:4", title: "居家生活场景图", prompt: "现代极简木质桌面与柔和窗边自然光，商品自然摆放在前景焦点位置，营造高级真实使用氛围，严格保持商品原始外观与配色不变。" },
  { label: "细节材质特写图", imageType: "detail" as const, ratio: "3:4", title: "细节材质特写", prompt: "微距商业静物特写镜头，柔和侧逆光勾勒商品表面纹理、工艺接缝与材质质感，浅景深干净背景，严格保持商品结构真实。" },
  { label: "活动促销海报主图", imageType: "main" as const, ratio: "1:1", title: "营销卖点主图", prompt: "高转化跨境电商主图构图，左侧预留干净留白以便后续排版卖点文案，右侧突出立体商品主体与柔和商业轮廓光，高级简洁。" },
];

export function CustomTaskModal({
  inputImages,
  imageOptions,
  onClose,
  onCreate,
}: {
  inputImages: ApiImage[];
  imageOptions: ImageOptions;
  onClose: () => void;
  onCreate: (input: { imageType: "main" | "detail"; title: string; purpose: string; promptDraft: string; sourceInputImageId: string | null; generationParams: Record<string, unknown> }) => Promise<void>;
}) {
  const [imageType, setImageType] = useState<"main" | "detail">("detail");
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const preferred = (options: string[], value: string) => options.includes(value) ? value : options[0] ?? value;
  const [ratio, setRatio] = useState("3:4");
  const [size, setSize] = useState("1K");
  const effectiveSize = preferred(imageOptions.sizes, size);
  const [quality, setQuality] = useState("medium");
  const [sourceInputImageId, setSourceInputImageId] = useState<string>(inputImages[0]?.id ?? "");
  const [promptDraft, setPromptDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const applyPreset = (preset: (typeof QUICK_SCENES)[number]) => {
    setImageType(preset.imageType);
    setRatio(preset.ratio);
    setTitle(preset.title);
    setPurpose(preset.label);
    setPromptDraft(preset.prompt);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !promptDraft.trim()) {
      setError("请填写任务标题和生图提示词");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onCreate({
        imageType,
        title: title.trim(),
        purpose: purpose.trim() || (imageType === "main" ? "画布自由新增主图" : "画布自由新增详情图"),
        promptDraft: promptDraft.trim(),
        sourceInputImageId: sourceInputImageId || null,
        generationParams: { ratio: preferred(imageOptions.aspectRatios, ratio), size: effectiveSize, quality },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建任务卡失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title="自由新增画布任务卡"
      titleId="custom-task-title"
      eyebrow="CUSTOM CANVAS TASK"
      closeLabel="关闭新增任务卡"
      onClose={onClose}
      dismissDisabled={saving}
      className="wb-style-drawer"
      backdropClassName="wb-style-drawer-backdrop"
    >
      <form className="wb-custom-task-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="wb-style-drawer-body">
          <div className="wb-quick-chips-block">
            <span>快速电商场景模板</span>
            <div className="wb-quick-chips">
              {QUICK_SCENES.map((scene) => (
                <button type="button" key={scene.label} onClick={() => applyPreset(scene)}>{scene.label}</button>
              ))}
            </div>
          </div>
          <div className="wb-custom-row">
            <label className="wb-style-field">
              <span>坑位类型</span>
              <select value={imageType} onChange={(event) => { const next = event.target.value as "main" | "detail"; setImageType(next); setRatio(next === "main" ? "1:1" : "3:4"); }}>
                <option value="main">主图</option>
                <option value="detail">详情页</option>
              </select>
            </label>
            <label className="wb-style-field">
              <span>画面比例</span>
              <select value={preferred(imageOptions.aspectRatios, ratio)} onChange={(event) => setRatio(event.target.value)}>
                {imageOptions.aspectRatios.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="wb-style-field">
              <span>分辨率</span>
              <select value={effectiveSize} onChange={(event) => setSize(event.target.value)}>
                {imageOptions.sizes.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label className="wb-style-field">
              <span>清晰度</span>
              <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
              </select>
            </label>
          </div>
          <ResolutionCostNote size={effectiveSize} className="wb-resolution-note" />
          <label className="wb-style-field">
            <span>任务标题 *</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：黑五促销主图 / 包装清单图" />
          </label>
          {inputImages.length > 0 && (
            <label className="wb-style-field">
              <span>参考商品底图</span>
              <select value={sourceInputImageId} onChange={(event) => setSourceInputImageId(event.target.value)}>
                <option value="">稍后绑定</option>
                {inputImages.map((img) => (
                  <option key={img.id} value={img.id}>原图 #{img.ordinal} · {img.originalFilename}</option>
                ))}
              </select>
            </label>
          )}
          <label className="wb-style-field">
            <span>生图提示词 *</span>
            <textarea rows={5} value={promptDraft} onChange={(event) => setPromptDraft(event.target.value)} placeholder="描述画面主体、光影、场景与禁止项；提交生成时将自动叠加当前生效的全局风格卡。" />
          </label>
          {error && <p className="wb-custom-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="wb-primary-action" disabled={saving}>{saving ? "创建中…" : "加入创作画布"}</button>
        </footer>
      </form>
    </Drawer>
  );
}
