import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle as KonvaCircle, Layer, Line, Rect as KonvaRect, Stage, Text as KonvaText, Transformer } from "react-konva";
import type Konva from "konva";
import { CHANGE_TEXT_MAX_LENGTH, CHANGE_TEXT_MAX_OPERATIONS, computeOutpaintCanvas, isOutpaintRatio, normalizeChangeTextReplacement, OUTPAINT_RATIOS, type OutpaintRatio } from "../../../shared/image-editor";
import { SUPPORTED_OUTPUT_LANGUAGES } from "../../../shared/workbench-delivery";
import { ApiHttpError, createIdempotencyKey, suiteApi, type ApiImageEditProductInput, type ApiImageEditSelection, type ApiImageEditTool, type ApiSuiteTask, type ApiTaskVersion } from "../../api/client";
import { Icon, ModelSettingsMessage } from "../../pages/shared";
import { versionGenerationPrompt } from "./versionGenerationPrompt";
import "./ImageEditorModal.css";

type EditTool = "re_edit" | "regenerate" | "add_text" | "change_text" | "inpaint" | "erase" | "expand" | "restore_product";
type MaskStroke = { mode: "draw" | "erase"; points: Array<{ x: number; y: number }>; size: number };
export type DraftOperation = { operationId: string; type: ApiImageEditTool; summary: string; sourceVersionId: string; payload: Record<string, unknown> };
const freshOperationId = (type: DraftOperation["type"]) => `${type}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
const editOperationType = (tool: Exclude<EditTool, "regenerate">): ApiImageEditTool => tool === "inpaint" ? "redraw" : tool === "expand" ? "outpaint" : tool;
const editorToolFor = (type: ApiImageEditTool): Exclude<EditTool, "regenerate"> => type === "redraw" ? "inpaint" : type === "outpaint" ? "expand" : type;
const DEFAULT_EDIT_TEXT_REGION = { x: 0.36, y: 0.42, width: 0.28, height: 0.1, rotation: 0 };
type TextEditRow = {
  operationId: string;
  originalText: string;
  newText: string;
  region: typeof DEFAULT_EDIT_TEXT_REGION;
  manual: boolean;
  prompt?: string;
};
type ImageEditCapabilities = Record<string, boolean>;
type ImageFrame = { left: number; top: number; width: number; height: number };

function formatClientOcrError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed) return "文字识别失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  if (/timeout|timed out|abort|OCR_TIMEOUT/i.test(trimmed)) {
    return "文字识别请求超时，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|socket/i.test(trimmed)) {
    return "文字识别服务连接失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/^OCR_HTTP_\d+$/.test(trimmed) || trimmed.startsWith("OCR_")) {
    return "文字识别服务返回异常，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  return "文字识别失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
}

export type ImageEditorTaskInput = Pick<ApiSuiteTask, "id" | "title" | "promptDraft">;
export type ImageEditorVersionInput = Pick<
  ApiTaskVersion,
  "id" | "versionNumber" | "previewUrl" | "width" | "height" | "promptSnapshot"
>;

export function ImageEditorModal({
  task,
  version,
  initialTool = "re_edit",
  onClose,
  onSubmit,
  onOperationAdded,
  onRegenerate = async () => undefined,
}: {
  task: ImageEditorTaskInput;
  version: ImageEditorVersionInput;
  initialTool?: EditTool;
  onClose: () => void;
  onSubmit: (selection: ApiImageEditSelection, instruction: string, idempotencyKey: string) => Promise<void>;
  onOperationAdded?: (operation: DraftOperation, instruction: string) => Promise<void>;
  onRegenerate?: () => Promise<void>;
}) {
  const [tool, setTool] = useState<EditTool>(initialTool);
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [activeStroke, setActiveStroke] = useState<MaskStroke | null>(null);
  const [maskMode, setMaskMode] = useState<"draw" | "erase">("draw");
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("新品主视觉");
  // Local-only canvas contrast preview toggle (never persisted into EditSnapshot)
  const [previewTone, setPreviewTone] = useState<"dark" | "light">("dark");
  const [textOperationId, setTextOperationId] = useState(() => freshOperationId("add_text"));
  const [brush, setBrush] = useState(42);
  const [expand, setExpand] = useState("all");
  const [selectedRatio, setRatio] = useState<OutpaintRatio | null>(null);
  const [outpaintRatios, setOutpaintRatios] = useState<readonly OutpaintRatio[]>(OUTPAINT_RATIOS);
  const ratio = selectedRatio ?? outpaintRatios[0] ?? "1:1";
  const [instruction, setInstruction] = useState("");
  const [addTextPrompt, setAddTextPrompt] = useState("");
  const [redrawPrompt, setRedrawPrompt] = useState("");
  const [erasePrompt, setErasePrompt] = useState("移除选区中的目标，并根据周围画面自然补全背景，保持原有光线、纹理和透视关系");
  const [operations, setOperations] = useState<DraftOperation[]>([]);
  const [productInputs, setProductInputs] = useState<ApiImageEditProductInput[]>([]);
  const [restoreInput, setRestoreInput] = useState<string | null>(null);
  const [uploadingRestoreInput, setUploadingRestoreInput] = useState(false);
  const [productInputsError, setProductInputsError] = useState(false);
  const workingDrafts = useRef<Partial<Record<ApiImageEditTool, DraftOperation>>>({});
  const submittedDraft = useRef<{ signature: string; key: string } | null>(null);
  const pendingDraftWrite = useRef(Promise.resolve());
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [toolNotice, setToolNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [textEdits, setTextEdits] = useState<TextEditRow[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectingTextRegion, setSelectingTextRegion] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const ocrAutoTriggeredRef = useRef(false);
  const [translateLang, setTranslateLang] = useState("英文");
  const [translating, setTranslating] = useState(false);
  const editorMounted = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [holdCompareOriginal, setHoldCompareOriginal] = useState(false);
  const [textRegion, setTextRegion] = useState(DEFAULT_EDIT_TEXT_REGION);
  const [capabilities, setCapabilities] = useState<ImageEditCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState("");
  const [feather, setFeather] = useState(0.08);
  const [redoStrokes, setRedoStrokes] = useState<MaskStroke[]>([]);
  const [regionStart, setRegionStart] = useState<{ x: number; y: number } | null>(null);
  const [activeRegion, setActiveRegion] = useState<typeof textRegion | null>(null);
  const [frame, setFrame] = useState<ImageFrame>({ left: 0, top: 0, width: 1, height: 1 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const textEditsListRef = useRef<HTMLDivElement | null>(null);
  const textNodeRef = useRef<Konva.Text | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const activeOperationType = tool === "regenerate" ? null : editOperationType(tool);
  const activeOperations = operations.filter((item) => item.type === activeOperationType);
  const textChanges = textEdits.filter((item) => item.originalText.trim() && item.originalText !== item.newText);
  const translatableText = textEdits.filter((item) => item.originalText.trim());
  const textEditLimitError = textChanges.length > CHANGE_TEXT_MAX_OPERATIONS
    ? `每次最多修改 ${CHANGE_TEXT_MAX_OPERATIONS} 条文字`
    : textChanges.some(({ originalText, newText }) => originalText.length > CHANGE_TEXT_MAX_LENGTH || newText.length > CHANGE_TEXT_MAX_LENGTH)
      ? `原文字和新文字每条最多 ${CHANGE_TEXT_MAX_LENGTH} 个字符`
      : "";
  const checkingCapabilities = !capabilities && !capabilityError;
  const outpaintReady = Boolean(capabilities && capabilities.outpaint !== false && outpaintRatios.length);
  const outpaintSelectionReady = outpaintReady && outpaintRatios.includes(ratio);

  const writeDraft = (write: () => Promise<unknown> | undefined) => {
    const pending = pendingDraftWrite.current.then(write).then(() => undefined);
    pendingDraftWrite.current = pending.catch(() => undefined);
    return pending;
  };

  const runOcr = useCallback(async () => {
    setOcrLoading(true);
    setOcrError("");
    try {
      const result = await suiteApi.recognizeImageEditText(task.id, version.id);
      if (result.status === "failed") {
        setOcrError(formatClientOcrError(result.error));
        return;
      }
      const recognized: TextEditRow[] = (result.blocks ?? [])
        .filter(({ text, bounds }) => text.trim() && bounds.width > 0 && bounds.height > 0)
        .map((block) => ({
          operationId: freshOperationId("change_text"),
          originalText: block.text,
          newText: block.text,
          region: { ...block.bounds, rotation: block.rotation },
          manual: false,
        }));
      setTextEdits((current) => {
        const unmatched = [...current];
        const merged = recognized.map((row) => {
          const { x, y, width, height, rotation } = row.region;
          const index = unmatched.findIndex(({ originalText, region }) => originalText === row.originalText
            && region.x === x && region.y === y && region.width === width && region.height === height && region.rotation === rotation);
          if (index < 0) return row;
          return { ...unmatched.splice(index, 1)[0], manual: false };
        });
        return [...merged, ...unmatched];
      });
    } catch (error) {
      setOcrError(formatClientOcrError(error));
    } finally {
      setOcrLoading(false);
    }
  }, [task.id, version.id]);

  const runBatchTranslate = async () => {
    if (!translatableText.length || translating) return;
    setTranslating(true);
    setEditorError("");
    try {
      const result = await suiteApi.translateImageTexts({
        targetLanguage: translateLang,
        items: translatableText.map((row) => ({ id: row.operationId, text: row.originalText })),
        preserveBrandTerms: true,
      });
      if (!editorMounted.current) return;
      const translations = new Map(result.translations.filter((row) => row.translatedText.trim()).map((row) => [row.id, row.translatedText]));
      setTextEdits((current) => current.map((row) => ({
        ...row, newText: translations.get(row.operationId) ?? row.newText,
      })));
      for (const { operationId, originalText } of translatableText) {
        if (translations.get(operationId) === originalText) removeSavedTextEdit(operationId);
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "图片文字翻译失败");
    } finally {
      setTranslating(false);
    }
  };

  useEffect(() => {
    editorMounted.current = true;
    suiteApi.imageEditorCapabilities().then((result) => {
      setOutpaintRatios(result.outpaintRatios ?? OUTPAINT_RATIOS);
      setCapabilities(result.capabilities);
    }).catch(() => setCapabilityError("能力状态暂时不可用"));
    return () => { editorMounted.current = false; };
  }, []);
  useEffect(() => {
    let mounted = true;
    suiteApi.getImageEditDraft(task.id, version.id).then((draft) => {
      if (!mounted) return;
      const restored = (draft.operations as unknown as DraftOperation[]).filter((item) => item.sourceVersionId === version.id);
      setOperations(restored);
      setTextEdits(restored.flatMap(({ type, operationId, payload }) => {
        const { originalText, newText, region, prompt } = payload;
        if (type !== "change_text" || typeof originalText !== "string" || typeof newText !== "string" || !region || typeof region !== "object") return [];
        const bounds = region as TextEditRow["region"];
        return [{ operationId, originalText, newText, region: { ...bounds, rotation: bounds.rotation ?? 0 }, manual: true,
          prompt: typeof prompt === "string" ? prompt : undefined }];
      }));
      setProductInputs(draft.productInputs ?? []);
      setProductInputsError(false);
      const reEdit = restored.find((item) => item.type === "re_edit");
      if (reEdit) setInstruction(String(reEdit.payload.prompt ?? ""));
    }).catch(() => { if (mounted) setProductInputsError(true); }).finally(() => { if (mounted) setLoadingDraft(false); });
    return () => { mounted = false; };
  }, [task.id, version.id]);

  const updateFrame = useCallback(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;
    const imageRect = image.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (!imageRect.width || !imageRect.height) return;
    setFrame({ left: imageRect.left - canvasRect.left, top: imageRect.top - canvasRect.top, width: imageRect.width, height: imageRect.height });
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(updateFrame);
    if (canvasRef.current) observer.observe(canvasRef.current);
    if (imageRef.current) observer.observe(imageRef.current);
    updateFrame();
    return () => observer.disconnect();
  }, [updateFrame, zoom]);

  useEffect(() => {
    ocrAutoTriggeredRef.current = false;
  }, [version.id]);

  useEffect(() => {
    if (tool !== "change_text") return;
    if (checkingCapabilities || capabilities?.ocr === false || ocrAutoTriggeredRef.current) return;
    ocrAutoTriggeredRef.current = true;
    void runOcr();
  }, [capabilities, checkingCapabilities, tool, runOcr]);
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = textNodeRef.current;
    if (!node || tool !== "add_text") {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([node]);
    transformer.getLayer()?.batchDraw();
  }, [tool, textOperationId, text, textRegion]);

  const undo = useCallback(() => {
    setStrokes((current) => {
      if (current.length) setRedoStrokes((redo) => [...redo, current[current.length - 1]]);
      return current.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStrokes((current) => {
      const item = current[current.length - 1];
      if (!item) return current;
      setStrokes((value) => [...value, item]);
      return current.slice(0, -1);
    });
  }, []);

  // Keyboard shortcuts for mask editing (skipped when typing in inputs)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") { onClose(); return; }
      if (!["inpaint", "erase"].includes(tool)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (event.key === "[") {
        event.preventDefault();
        setBrush((value) => Math.max(12, value - 6));
      } else if (event.key === "]") {
        event.preventDefault();
        setBrush((value) => Math.min(120, value + 6));
      } else if (event.code === "Space") {
        event.preventDefault();
        setHoldCompareOriginal(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setHoldCompareOriginal(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [tool, undo, redo, onClose]);

  const pointFromEvent = (event: { target: { getStage(): Konva.Stage | null } }) => {
    const point = event.target.getStage()?.getPointerPosition() ?? { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(1, point.x / Math.max(1, frame.width))), y: Math.max(0, Math.min(1, point.y / Math.max(1, frame.height))) };
  };
  const selectTextEdit = ({ operationId, region }: TextEditRow, center = false) => {
    setSelectedTextId(operationId);
    const scroll = canvasScrollRef.current;
    const canvas = canvasRef.current;
    if (!center || !scroll || !canvas) return;
    const viewport = scroll.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    scroll.scrollTo({
      left: scroll.scrollLeft + canvasRect.left - viewport.left + frame.left + (region.x + region.width / 2) * frame.width - scroll.clientWidth / 2,
      top: scroll.scrollTop + canvasRect.top - viewport.top + frame.top + (region.y + region.height / 2) * frame.height - scroll.clientHeight / 2,
    });
  };

  useEffect(() => {
    if (selectedTextId && tool === "change_text") {
      textEditsListRef.current?.querySelector(".wb-text-edit-row.is-active")?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedTextId, tool]);

  const startStroke = (event: { target: { getStage(): Konva.Stage | null } }) => {
    if (saving) return;
    const point = pointFromEvent(event);
    if (["inpaint", "erase"].includes(tool)) {
      setActiveStroke({ mode: maskMode, points: [point], size: brush / Math.max(1, Math.min(frame.width, frame.height)) });
      setRedoStrokes([]);
      return;
    }
    if (tool === "change_text" && selectingTextRegion && !translating) {
      setRegionStart(point);
      setActiveRegion({ x: point.x, y: point.y, width: 0, height: 0, rotation: 0 });
    }
  };
  const movePointer = (event: { target: { getStage(): Konva.Stage | null } }) => {
    const point = pointFromEvent(event);
    setPointer({ x: point.x * frame.width, y: point.y * frame.height });
    if (activeStroke) setActiveStroke((stroke) => stroke ? { ...stroke, points: [...stroke.points, point] } : stroke);
    if (regionStart) setActiveRegion({ x: Math.min(regionStart.x, point.x), y: Math.min(regionStart.y, point.y), width: Math.abs(point.x - regionStart.x), height: Math.abs(point.y - regionStart.y), rotation: 0 });
  };
  const finishStroke = () => {
    if (activeStroke) { setStrokes((current) => [...current, activeStroke]); setActiveStroke(null); return; }
    if (activeRegion && activeRegion.width * frame.width >= 4 && activeRegion.height * frame.height >= 4) {
      const row = { operationId: freshOperationId("change_text"), originalText: "", newText: "", region: activeRegion, manual: true };
      setTextEdits((current) => [...current, row]);
      selectTextEdit(row);
      setSelectingTextRegion(false);
    }
    setRegionStart(null);
    setActiveRegion(null);
  };

  const operationFor = (type: Exclude<ApiImageEditTool, "change_text">): DraftOperation => {
    const operation = (summary: string, payload: DraftOperation["payload"]): DraftOperation => {
      const existing = workingDrafts.current[type]?.operationId ?? operations.find((item) => item.type === type)?.operationId;
      const operationId = type === "add_text" ? textOperationId : existing ?? freshOperationId(type);
      return { operationId, type, summary, sourceVersionId: version.id, payload };
    };
    switch (type) {
      case "re_edit":
        return operation("AI 改图", { prompt: instruction });
      case "add_text":
        return operation(`添加文本：${text}`, { text, region: textRegion, prompt: addTextPrompt });
      case "redraw":
      case "erase":
        return operation(type === "redraw" ? "局部重绘选区" : "消除笔移除选区", {
          strokes: strokes.map((stroke) => ({ mode: stroke.mode, points: stroke.points, width: stroke.size })),
          feather, prompt: type === "redraw" ? redrawPrompt : erasePrompt,
        });
      case "outpaint":
        return operation(`扩图：${expand} · ${ratio}`, { direction: expand, targetRatio: ratio });
      case "restore_product":
        return operation("商品还原", restoreInput ? { referenceObjectKeys: [restoreInput] } : {});
    }
  };

  const validationError = () => {
    if (tool === "add_text" && (!text.trim() || !addTextPrompt.trim())) return "请填写精确文字和添加文字要求";
    if (tool === "inpaint" && (!strokes.length || !redrawPrompt.trim())) return "请绘制选区并填写重绘要求";
    if (tool === "erase" && !strokes.length) return "请先绘制要清除的选区";
    if (tool === "restore_product" && !restoreInput && !productInputs.length) return "请上传一张商品外观依据图";
    return "";
  };

  const uploadRestoreInput = async (file: File) => {
    setUploadingRestoreInput(true);
    setEditorError("");
    try {
      const uploaded = await suiteApi.uploadImageEditRestoreInput(task.id, version.id, file);
      setRestoreInput(uploaded.objectKey);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "依据图上传失败");
    } finally {
      setUploadingRestoreInput(false);
    }
  };

  const addOperation = async () => {
    if (!activeOperationType || activeOperationType === "change_text") return;
    const error = validationError();
    if (error) { setEditorError(error); return; }
    const next = operationFor(activeOperationType);
    setSaving(true);
    setEditorError("");
    try {
      await writeDraft(() => onOperationAdded?.(next, next.summary));
      setOperations((current) => [...current.filter((item) => item.operationId !== next.operationId), next]);
    } catch (errorValue) {
      setEditorError(errorValue instanceof Error ? errorValue.message : "操作保存失败");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!activeOperationType || activeOperationType === "change_text" || saving || loadingDraft) return;
    if (activeOperationType === "outpaint" && !outpaintSelectionReady) return;
    const next = operationFor(activeOperationType);
    const current = operations.find((item) => item.operationId === next.operationId);
    if (!current || (current.summary === next.summary && JSON.stringify(current.payload) === JSON.stringify(next.payload))) return;
    const timer = window.setTimeout(() => {
      setOperations((items) => items.map((item) => item.operationId === next.operationId ? next : item));
      void writeDraft(() => onOperationAdded?.(next, next.summary)).catch(() => setEditorError("对话操作同步失败，请重试"));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeOperationType, saving, loadingDraft, text, textRegion, strokes, feather, expand, ratio, outpaintSelectionReady, instruction, addTextPrompt, redrawPrompt, erasePrompt, textOperationId, restoreInput, operations]);

  const submit = async () => {
    if (!activeOperationType) return;
    let finalOperations: DraftOperation[];
    if (activeOperationType === "change_text") {
      if (!textChanges.length || translating || textEditLimitError) return;
      finalOperations = textChanges.map(({ operationId, originalText, newText, region, prompt }) => {
        const replacement = normalizeChangeTextReplacement(newText);
        return {
          operationId,
          type: "change_text",
          summary: replacement === "" ? `删除文字：${originalText}` : `编辑文字：${originalText} → ${replacement}`,
          sourceVersionId: version.id,
          payload: { originalText, newText: replacement, region, ...(prompt ? { prompt } : {}) },
        };
      });
    } else {
      const next = operationFor(activeOperationType);
      const multiple = activeOperationType === "add_text";
      const currentError = validationError();
      if (currentError && (!multiple || !activeOperations.length || activeOperations.some((item) => item.operationId === next.operationId))) {
        setEditorError(currentError);
        return;
      }
      finalOperations = currentError ? activeOperations
        : multiple ? [...activeOperations.filter((item) => item.operationId !== next.operationId), next] : [next];
    }
    setSaving(true);
    setEditorError("");
    try {
      const signature = JSON.stringify([task.id, version.id, finalOperations]);
      if (submittedDraft.current?.signature !== signature) {
        await writeDraft(async () => {
          for (const operation of finalOperations) {
            await onOperationAdded?.(operation, operation.summary);
            if (activeOperationType === "change_text") {
              setOperations((current) => [...current.filter((item) => item.operationId !== operation.operationId), operation]);
            }
          }
        });
        submittedDraft.current = { signature, key: createIdempotencyKey() };
      }
      setOperations((current) => [
        ...current.filter((item) => !finalOperations.some((submitted) => submitted.operationId === item.operationId)),
        ...finalOperations,
      ]);
      await onSubmit(
        { tool: activeOperationType, sourceVersionId: version.id, operationIds: finalOperations.map((item) => item.operationId) },
        finalOperations.map((item) => item.summary).join("；"),
        submittedDraft.current.key,
      );
      submittedDraft.current = null;
      setOperations((current) => current.filter((item) => !finalOperations.some((submitted) => submitted.operationId === item.operationId)));
      if (activeOperationType === "change_text") {
        setTextEdits((current) => current.map((row) => ({ ...row, newText: row.originalText })));
      }
    } catch (errorValue) {
      if (errorValue instanceof ApiHttpError && (errorValue.code === "EDIT_DRAFT_CHANGED" || errorValue.code === "EDIT_OPERATIONS_REQUIRED")) {
        submittedDraft.current = null;
      }
      setEditorError(errorValue instanceof Error ? errorValue.message : "生成提交失败");
    } finally {
      setSaving(false);
    }
  };

  const restoreOperation = (item: DraftOperation) => {
    const { payload } = item;
    switch (item.type) {
      case "add_text":
        setTextOperationId(item.operationId);
        setText(String(payload.text ?? ""));
        setAddTextPrompt(String(payload.prompt ?? ""));
        break;
      case "redraw":
        setRedrawPrompt(String(payload.prompt ?? ""));
        break;
      case "erase":
        setErasePrompt(String(payload.prompt ?? ""));
        break;
      case "outpaint":
        setExpand(String(payload.direction ?? "all"));
        setRatio(isOutpaintRatio(payload.targetRatio) ? payload.targetRatio : null);
        break;
      case "re_edit":
        setInstruction(String(payload.prompt ?? ""));
        break;
      case "restore_product":
        setRestoreInput(Array.isArray(payload.referenceObjectKeys) ? String(payload.referenceObjectKeys[0] ?? "") || null : null);
        break;
    }
    if (item.type === "add_text" && payload.region && typeof payload.region === "object") {
      setTextRegion(payload.region as typeof textRegion);
    }
    if (item.type === "redraw" || item.type === "erase") {
      if (Array.isArray(payload.strokes)) setStrokes((payload.strokes as Array<{ mode?: "draw" | "erase"; points: MaskStroke["points"]; width: number }>).map((stroke) => ({ mode: stroke.mode ?? "draw", points: stroke.points, size: stroke.width })));
      if (typeof payload.feather === "number") setFeather(payload.feather);
    }
  };

  const switchTool = (next: EditTool, selected?: DraftOperation) => {
    if (tool === next && !selected) return;
    if (activeOperationType && activeOperationType !== "change_text") workingDrafts.current[activeOperationType] = operationFor(activeOperationType);
    setEditorError("");
    if (tool !== next) {
      setToolNotice("切换前的草稿会保留，提交时只使用当前工具的草稿。");
      setTool(next);
    }
    setTextRegion(DEFAULT_EDIT_TEXT_REGION);
    setStrokes([]);
    setRedoStrokes([]);
    setActiveStroke(null);
    setFeather(0.08);
    setRegionStart(null);
    setActiveRegion(null);
    setSelectingTextRegion(false);
    if (next !== "regenerate" && next !== "change_text") {
      const nextType = editOperationType(next);
      const draft = selected ?? workingDrafts.current[nextType] ?? operations.find((item) => item.type === nextType);
      if (draft) {
        workingDrafts.current[nextType] = draft;
        restoreOperation(draft);
      }
    }
  };

  const removeOperation = async (operationId: string) => {
    const item = operations.find((operation) => operation.operationId === operationId);
    if (item && workingDrafts.current[item.type]?.operationId === operationId) delete workingDrafts.current[item.type];
    setOperations((current) => current.filter((operation) => operation.operationId !== operationId));
    try {
      await writeDraft(() => suiteApi.removeImageEditOperation(task.id, operationId));
    } catch (errorValue) {
      if (item) setOperations((current) => [...current, item]);
      setEditorError(errorValue instanceof Error ? errorValue.message : "移除草稿失败");
    }
  };

  const removeSavedTextEdit = (id: string) => {
    if (activeOperations.some((item) => item.operationId === id)) void removeOperation(id);
  };

  const updateTextEdit = (row: TextEditRow, update: Partial<Pick<TextEditRow, "originalText" | "newText">>) => {
    const next = { ...row, ...update };
    setTextEdits((current) => current.map((item) => item.operationId === row.operationId ? { ...item, ...update } : item));
    if (next.newText === next.originalText) removeSavedTextEdit(row.operationId);
  };

  const updateTextRegion = (node: Konva.Text, transformed = false) => {
    const scaleX = transformed ? node.scaleX() : 1;
    const scaleY = transformed ? node.scaleY() : 1;
    const width = Math.max(24 / frame.width, node.width() * scaleX / frame.width);
    const height = Math.max(18 / frame.height, node.height() * scaleY / frame.height);
    if (transformed) { node.scaleX(1); node.scaleY(1); }
    setTextRegion({
      x: Math.max(0, Math.min(1 - width, (node.x() - width * frame.width / 2) / frame.width)),
      y: Math.max(0, Math.min(1 - height, (node.y() - height * frame.height / 2) / frame.height)),
      width: Math.min(1, width),
      height: Math.min(1, height),
      rotation: node.rotation(),
    });
  };

  const toolList: Array<[EditTool, string, string]> = [
    ["re_edit", "AI 改图", "imageToImage"],
    ["regenerate", "再次生成", "currentVersionInput"],
    ["add_text", "添加文本", "addText"],
    ["change_text", "编辑文字", "changeText"],
    ["inpaint", "局部重绘", "redraw"],
    ["erase", "消除笔", "erase"],
    ["expand", "扩图", "outpaint"],
    ["restore_product", "商品还原", "imageToImage"],
  ];
  const activeCapability = toolList.find(([value]) => value === tool)?.[2];
  const capabilityAvailable = (value: EditTool, capability: string) => value === "expand" ? outpaintReady : capabilities?.[capability] !== false;
  const capabilityReady = tool === "expand" ? outpaintSelectionReady : capabilityAvailable(tool, activeCapability ?? "");
  const outpaintBox = useMemo(
    () => computeOutpaintCanvas(version.width || 1024, version.height || 1024, ratio),
    [version.width, version.height, ratio],
  );
  const targetSize = { width: outpaintBox.targetWidth, height: outpaintBox.targetHeight };
  const quickDirectives: Record<string, string[]> = {
    inpaint: ["保持商品本体轮廓与颜色严格不变", "替换为极简柔和影棚光影", "增强材质高光与真实质感", "补充柔和自然桌面接触阴影"],
    erase: ["无痕移除杂物与水印，自然延续周围纹理", "清除多余瑕疵与反光斑点，保持原光影"],
    add_text: ["现代无衬线商业排版，清晰高对比，与画面光影融合", "极简高端品牌副标题排版，居中对齐"],
    re_edit: ["优化整体商业光影质感", "提升画面明暗层次与电商点击吸引力"],
  };
  const appendQuickDirective = (phrase: string) => {
    const append = (prev: string) => (prev.trim() ? `${prev.trim()}；${phrase}` : phrase);
    if (tool === "inpaint") setRedrawPrompt(append);
    else if (tool === "erase") setErasePrompt(append);
    else if (tool === "add_text") setAddTextPrompt(append);
    else if (tool === "re_edit") setInstruction(append);
  };
  const textVisible = tool === "add_text";
  const textOperations = tool === "change_text" ? [] : operations.filter((item) => item.type === "add_text");
  const hasActiveTextOperation = textOperations.some((item) => item.operationId === textOperationId);
  const hasRecognizedText = textEdits.some((row) => !row.manual);
  const selectingText = tool === "change_text" && selectingTextRegion;

  const previewFill = previewTone === "dark" ? "#0f172a" : "#ffffff";
  const previewShadow = previewTone === "dark" ? "#ffffff" : "#0f172a";

  return (
    <div className="wb-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="wb-editor-modal" role="dialog" aria-modal="true" aria-label="图片编辑器">
        <header className="wb-editor-head">
          <div>
            <strong>{task.title}</strong>
            <small>基于版本 v{version.versionNumber}，原版本与提示词快照不会被覆盖</small>
          </div>
          <button type="button" aria-label="关闭图片编辑器" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="wb-editor-body">
          <aside className="wb-editor-tools">
            <strong>编辑工具</strong>
            {toolList.map(([value, label, capability]) => (
              <button key={value} type="button" className={tool === value ? "is-active" : ""} disabled={saving || loadingDraft || !capabilityAvailable(value, capability)} onClick={() => switchTool(value)}>
                {label}
                <small>{value === "expand" && checkingCapabilities ? "检查中" : !capabilityAvailable(value, capability) ? "不可用" : capabilities ? "可用" : "检查中"}</small>
              </button>
            ))}
            {tool !== "change_text" && <p>{["inpaint", "erase"].includes(tool) ? "快捷键：Ctrl+Z 撤销 · [ / ] 调整笔刷大小" : "调整操作后添加到对话，生成时才冻结"}</p>}
            {toolNotice && <p role="status">{toolNotice}</p>}
            {capabilityError && <p className="wb-editor-error">{capabilityError}</p>}
            {capabilities && !outpaintRatios.length && <p role="status">当前生图渠道没有可用的扩图比例。</p>}
          </aside>
          <div className="wb-editor-stage">
            <div className={`wb-editor-canvas-scroll${tool === "change_text" ? " wb-text-edit-canvas-scroll" : ""}`} ref={canvasScrollRef}>
              <div className="wb-editor-canvas" ref={canvasRef} style={{ width: `${Math.round(zoom * 100)}%`, height: `${Math.round(zoom * 100)}%` }}>
                <img ref={imageRef} onLoad={updateFrame} src={version.previewUrl} alt={task.title} />
                <Stage
                  width={frame.width} height={frame.height}
                  style={{ position: "absolute", left: frame.left, top: frame.top, cursor: selectingText ? "crosshair" : undefined, touchAction: selectingText ? "none" : undefined }}
                  onMouseDown={startStroke} onMousemove={movePointer} onMouseup={finishStroke}
                  onMouseleave={() => { setPointer(null); finishStroke(); }}
                  onTouchStart={selectingText ? startStroke : undefined}
                  onTouchMove={selectingText ? movePointer : undefined}
                  onTouchEnd={selectingText ? finishStroke : undefined}
                >
                  <Layer visible={!holdCompareOriginal}>
                    {tool === "change_text" && textEdits.map((row) => {
                      const { x, y, width, height } = row.region;
                      const selected = row.operationId === selectedTextId;
                      return <KonvaRect key={row.operationId} x={x * frame.width} y={y * frame.height} width={width * frame.width} height={height * frame.height}
                        fill={selected ? "rgba(61, 139, 253, 0.22)" : "rgba(195, 148, 22, 0.12)"}
                        stroke={selected ? "#3d8bfd" : "#c39416"} dash={selected ? undefined : [7, 5]} strokeWidth={selected ? 3 : 1.5}
                        listening={!selectingText} onClick={() => selectTextEdit(row)} onTap={() => selectTextEdit(row)} />;
                    })}
                    {strokes.map((stroke, index) => <Line key={index} points={stroke.points.flatMap((point) => [point.x * frame.width, point.y * frame.height])} stroke={stroke.mode === "erase" ? "#64748b" : "#e45757"} opacity={stroke.mode === "erase" ? 0.46 : 0.62} strokeWidth={stroke.size * Math.min(frame.width, frame.height)} lineCap="round" lineJoin="round" globalCompositeOperation={stroke.mode === "erase" ? "destination-out" : "source-over"} />)}
                    {activeStroke && <Line points={activeStroke.points.flatMap((point) => [point.x * frame.width, point.y * frame.height])} stroke="#e45757" opacity={0.62} strokeWidth={activeStroke.size * Math.min(frame.width, frame.height)} lineCap="round" lineJoin="round" />}
                    {activeRegion && <KonvaRect x={activeRegion.x * frame.width} y={activeRegion.y * frame.height} width={activeRegion.width * frame.width} height={activeRegion.height * frame.height} stroke="#3d8bfd" dash={[6, 4]} strokeWidth={1.5} />}
                    {textOperations.map((item) => {
                      const payload = item.payload;
                      const selected = tool === "add_text" && item.operationId === textOperationId;
                      const region = selected || !payload.region || typeof payload.region !== "object" ? textRegion : payload.region as typeof textRegion;
                      return (
                        <KonvaText
                          key={item.operationId}
                          ref={selected ? textNodeRef : undefined}
                          text={selected ? text : String(payload.text ?? "")}
                          x={(region.x + region.width / 2) * frame.width}
                          y={(region.y + region.height / 2) * frame.height}
                          offsetX={region.width * frame.width / 2}
                          offsetY={region.height * frame.height / 2}
                          width={region.width * frame.width}
                          height={region.height * frame.height}
                          fill={previewFill}
                          fontSize={Math.max(14, region.height * frame.height * 0.55)}
                          rotation={region.rotation}
                          draggable={selected}
                          shadowColor={previewShadow}
                          shadowBlur={6}
                          onClick={() => { if (!saving && !selected) switchTool("add_text", item); }}
                          onTap={() => { if (!saving && !selected) switchTool("add_text", item); }}
                          onDragEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text) : undefined}
                          onTransformEnd={selected ? (event) => updateTextRegion(event.target as Konva.Text, true) : undefined}
                        />
                      );
                    })}
                    {textVisible && !hasActiveTextOperation && (
                      <KonvaText
                        ref={textNodeRef}
                        text={text}
                        x={(textRegion.x + textRegion.width / 2) * frame.width}
                        y={(textRegion.y + textRegion.height / 2) * frame.height}
                        offsetX={textRegion.width * frame.width / 2}
                        offsetY={textRegion.height * frame.height / 2}
                        width={textRegion.width * frame.width}
                        height={textRegion.height * frame.height}
                        fill={previewFill}
                        fontSize={Math.max(14, textRegion.height * frame.height * 0.55)}
                        rotation={textRegion.rotation}
                        draggable
                        shadowColor={previewShadow}
                        shadowBlur={6}
                        onDragEnd={(event) => updateTextRegion(event.target as Konva.Text)}
                        onTransformEnd={(event) => updateTextRegion(event.target as Konva.Text, true)}
                      />
                    )}
                    {textVisible && <Transformer ref={transformerRef} borderDash={[6, 4]} borderStroke="#3d8bfd" anchorStroke="#3d8bfd" anchorFill="#ffffff" rotateAnchorOffset={22} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} boundBoxFunc={(oldBox, newBox) => newBox.width < 24 || newBox.height < 18 ? oldBox : newBox} />}
                    {["inpaint", "erase"].includes(tool) && pointer && <KonvaCircle x={pointer.x} y={pointer.y} radius={brush / 2} stroke={maskMode === "erase" ? "#475569" : "#dc3f3f"} dash={maskMode === "erase" ? [4, 3] : undefined} strokeWidth={1.5} listening={false} />}
                  </Layer>
                </Stage>
                {tool === "expand" && outpaintSelectionReady && (
                  <div className="wb-outpaint-overlay">
                    <div className="wb-outpaint-frame" style={{ aspectRatio: `${outpaintBox.targetWidth} / ${outpaintBox.targetHeight}` }}>
                      <div
                        className="wb-outpaint-origin"
                        style={{
                          left: `${outpaintBox.sourceOffset.left / targetSize.width * 100}%`,
                          top: `${outpaintBox.sourceOffset.top / targetSize.height * 100}%`,
                          width: `${(version.width || 1024) / targetSize.width * 100}%`,
                          height: `${(version.height || 1024) / targetSize.height * 100}%`,
                        }}
                      >
                        <img src={version.previewUrl} alt="原图锚点" />
                      </div>
                    </div>
                    <div className="wb-outpaint-caption">
                      <span>待扩展画幅预览</span>
                      <strong>{targetSize.width} × {targetSize.height}</strong>
                      <small>原图居中</small>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="wb-editor-bottom">
              <span>{strokes.length ? `已记录 ${strokes.length} 条蒙版笔画` : selectingText ? "在图上拖动，框住要编辑的文字" : tool === "change_text" ? "点击文字框或列表条目定位" : textVisible ? "拖动或缩放虚线框定位文字区域" : "未绘制选区"}</span>
              <div className="wb-zoom-controls" role="group" aria-label="画布缩放控制">
                <button type="button" onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))} aria-label="缩小画布">−</button>
                <button type="button" onClick={() => setZoom(1)} title="重置为 100%">{Math.round(zoom * 100)}%</button>
                <button type="button" onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))} aria-label="放大画布">+</button>
              </div>
              {["inpaint", "erase"].includes(tool) && (
                <button
                  type="button"
                  className={holdCompareOriginal ? "is-active" : ""}
                  onPointerDown={() => setHoldCompareOriginal(true)}
                  onPointerUp={() => setHoldCompareOriginal(false)}
                  onPointerLeave={() => setHoldCompareOriginal(false)}
                  title="按住按钮或空格键临时隐藏蒙版查看原图"
                >
                  按住看原图
                </button>
              )}
              {textVisible && (
                <div className="wb-mask-mode" role="group" aria-label="画布文字预览对比度">
                  <button type="button" className={previewTone === "dark" ? "is-active" : ""} onClick={() => setPreviewTone("dark")}>深色预览</button>
                  <button type="button" className={previewTone === "light" ? "is-active" : ""} onClick={() => setPreviewTone("light")}>浅色预览</button>
                </div>
              )}
              {["inpaint", "erase"].includes(tool) && (
                <div className="wb-mask-mode" role="group" aria-label="蒙版修正模式">
                  <button type="button" className={maskMode === "draw" ? "is-active" : ""} onClick={() => setMaskMode("draw")}>绘制选区</button>
                  <button type="button" className={maskMode === "erase" ? "is-active" : ""} onClick={() => setMaskMode("erase")}>擦除选区</button>
                </div>
              )}
              <button type="button" disabled={!strokes.length} onClick={undo}>撤销</button>
              <button type="button" disabled={!redoStrokes.length} onClick={redo}>重做</button>
              <button type="button" disabled={!strokes.length} onClick={() => { setStrokes([]); setRedoStrokes([]); }}>清空</button>
            </div>
          </div>
          <aside className="wb-editor-options">
            {["inpaint", "erase", "expand"].includes(tool) && <p role="status">当前模型对选区控制有限</p>}
            {tool === "re_edit" && (
              <>
                <label>
                  调整要求
                  <textarea
                    value={instruction}
                    disabled={loadingDraft || saving}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="输入调整要求（选填，空着将按原提示词重绘）。如：商品向左移动一点，换成浅灰色背景…"
                  />
                </label>
                <details className="wb-editor-source-prompt">
                  <summary>原提示词</summary>
                  <p>{versionGenerationPrompt(version.promptSnapshot) || "暂无原提示词"}</p>
                </details>
              </>
            )}
            {tool === "add_text" && (
              <>
                <div className="wb-editor-option-head">
                  <strong>文字区域</strong>
                  <button type="button" onClick={() => { setTextOperationId(freshOperationId("add_text")); setText(""); setAddTextPrompt(""); setTextRegion(DEFAULT_EDIT_TEXT_REGION); }}>新建文字框</button>
                </div>
                <label>精确文字<input value={text} onChange={(event) => setText(event.target.value)} /></label>
                <label>添加文字要求<textarea value={addTextPrompt} onChange={(event) => setAddTextPrompt(event.target.value)} placeholder="描述文字的视觉感觉，以及与画面光线、透视的关系" /></label>
                <small>上方浅/深切换仅用于画布定位清晰度，实际视觉风格由“添加文字要求”控制。</small>
                <button type="button" className="wb-danger-link" disabled={saving} onClick={() => { if (operations.some((item) => item.operationId === textOperationId)) void removeOperation(textOperationId); setTextOperationId(freshOperationId("add_text")); setText(""); }}>删除当前文字框</button>
              </>
            )}
            {tool === "change_text" && (
              <>
                <div className="wb-editor-option-head">
                  <strong>文字列表</strong>
                  <button type="button" aria-pressed={selectingText} disabled={saving || translating} onClick={() => setSelectingTextRegion((value) => !value)}>
                    {selectingText ? "取消框选" : "框选补充"}
                  </button>
                </div>
                <div className="wb-text-edit-status" role="status">
                  {capabilities?.ocr === false ? <span>当前未配置多模态识字模型。可以框选补充文字。</span>
                    : checkingCapabilities ? <span>正在检查文字识别能力…</span>
                    : ocrLoading ? <span>正在识别整张图的文字…</span>
                    : !hasRecognizedText && (
                      <>
                        <span>{ocrError || "未识别到文字，可以框选补充。"}</span>
                        <button type="button" disabled={saving || translating} onClick={() => void runOcr()}>重新识别</button>
                      </>
                    )}
                </div>
                {textEdits.length > 0 && (
                  <div className="wb-translate-controls" aria-label="一键翻译">
                    <select aria-label="翻译目标语言" value={translateLang} disabled={saving || translating} onChange={(event) => setTranslateLang(event.target.value)}>
                      {SUPPORTED_OUTPUT_LANGUAGES.map((lang) => (
                        <option key={lang.code} value={lang.value}>{lang.value}</option>
                      ))}
                    </select>
                    <button type="button" disabled={saving || translating || ocrLoading || !translatableText.length} onClick={() => void runBatchTranslate()}>
                      {translating ? "翻译中…" : "一键翻译"}
                    </button>
                  </div>
                )}
                <div className="wb-text-edit-list" ref={textEditsListRef}>
                  {textEdits.map((row) => {
                    const { operationId, originalText, newText, manual } = row;
                    const selected = selectedTextId === operationId;
                    const deleted = Boolean(originalText.trim()) && newText.trim() === "";
                    const disabled = saving || translating;
                    return (
                      <div className={`wb-text-edit-row${selected ? " is-active" : ""}`} key={operationId}>
                        <button type="button" className="wb-text-edit-locate" aria-pressed={selected} onClick={() => selectTextEdit(row, true)}>
                          {manual ? "手工框选文字" : originalText}
                        </button>
                        {manual && <label>原文字<input disabled={disabled} maxLength={CHANGE_TEXT_MAX_LENGTH} value={originalText} onFocus={() => selectTextEdit(row, true)} onChange={(event) => {
                          const value = event.target.value;
                          updateTextEdit(row, { originalText: value, ...(newText === originalText ? { newText: value } : {}) });
                        }} /></label>}
                        <label>新文字<textarea disabled={disabled} maxLength={CHANGE_TEXT_MAX_LENGTH} rows={1} aria-label={originalText ? `新文字：${originalText}` : "新文字"} value={newText}
                          placeholder={deleted ? "生成时删除这条文字" : undefined}
                          onFocus={() => selectTextEdit(row, true)} onChange={(event) => updateTextEdit(row, { newText: event.target.value })} /></label>
                        <div className="wb-text-edit-actions">
                          <button type="button" className="wb-danger-link" disabled={disabled || !originalText.trim() || deleted} onClick={() => updateTextEdit(row, { newText: "" })}>删除</button>
                          <button type="button" disabled={disabled || newText === originalText} onClick={() => updateTextEdit(row, { newText: originalText })}>重置</button>
                          {manual && <button type="button" disabled={disabled} onClick={() => {
                            setTextEdits((current) => current.filter((item) => item.operationId !== operationId));
                            if (selected) setSelectedTextId(null);
                            removeSavedTextEdit(operationId);
                          }}>移除框选</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {["inpaint", "erase"].includes(tool) && (
              <>
                <label>笔刷大小<input type="range" min="12" max="120" value={brush} onChange={(event) => setBrush(Number(event.target.value))} /><output>{brush}px</output></label>
                <label>边缘羽化<input type="range" min="0" max="40" value={Math.round(feather * 100)} onChange={(event) => setFeather(Number(event.target.value) / 100)} /><output>{Math.round(feather * 100)}%</output></label>
                {tool === "inpaint" ? <label>重绘要求<textarea value={redrawPrompt} onChange={(event) => setRedrawPrompt(event.target.value)} placeholder="描述选区中要重绘成什么，以及需要保留的画面关系" /></label> : <label>清除要求<textarea value={erasePrompt} onChange={(event) => setErasePrompt(event.target.value)} /></label>}
              </>
            )}
            {quickDirectives[tool] && (
              <div className="wb-quick-chips-block">
                <span>电商高频精修指令</span>
                <div className="wb-quick-chips">
                  {quickDirectives[tool].map((phrase) => (
                    <button type="button" key={phrase} onClick={() => appendQuickDirective(phrase)}>+ {phrase}</button>
                  ))}
                </div>
              </div>
            )}
            {tool === "expand" && outpaintReady && (
              <>
                <label>扩图重点<select value={expand} onChange={(event) => setExpand(event.target.value)}><option value="all">四周</option><option value="horizontal">左右</option><option value="vertical">上下</option><option value="left">左侧</option><option value="right">右侧</option></select></label>
                <label>目标比例
                  <select value={outpaintSelectionReady ? ratio : ""} onChange={(event) => { if (isOutpaintRatio(event.target.value)) setRatio(event.target.value); }}>
                    {!outpaintSelectionReady && <option value="" disabled>请选择可用比例</option>}
                    {outpaintRatios.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                {outpaintSelectionReady && <output>扩边画布 {targetSize.width} × {targetSize.height}</output>}
              </>
            )}
            {tool === "regenerate" && <p>再次生成只在当前卡片下新增版本，不创建子卡片。</p>}
            {tool === "restore_product" && (
              <fieldset className="wb-restore-inputs" disabled={saving || loadingDraft || uploadingRestoreInput}>
                <legend>商品外观依据</legend>
                {loadingDraft && <small>正在读取商品原图…</small>}
                {productInputsError && <small>商品原图读取失败，可以上传依据图。</small>}
                {!loadingDraft && !productInputsError && !productInputs.length && <small>当前图片没有商品原图，请上传一张依据图。</small>}
                {productInputs.length > 0 && (
                  <>
                    <label className="wb-restore-choice">
                      <input type="radio" name="restore-input" checked={restoreInput === null} onChange={() => { setRestoreInput(null); setEditorError(""); }} />
                      使用全部商品原图
                    </label>
                    <div className="wb-restore-grid">
                      {productInputs.map(({ objectKey, thumbnailUrl }, index) => (
                        <label className="wb-restore-choice" key={objectKey}>
                          <img src={thumbnailUrl} alt="" />
                          <input type="radio" name="restore-input" checked={restoreInput === objectKey} onChange={() => { setRestoreInput(objectKey); setEditorError(""); }} />
                          原图 {index + 1}
                        </label>
                      ))}
                    </div>
                  </>
                )}
                {restoreInput && !productInputs.some((input) => input.objectKey === restoreInput) && (
                  <div className="wb-restore-uploaded">
                    <img src={suiteApi.imageEditRestoreInputThumbnail(task.id, version.id, restoreInput)} alt="已上传的商品外观依据图" />
                    <span>已选上传图</span>
                  </div>
                )}
                <label>
                  {uploadingRestoreInput ? "上传中…" : "上传"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void uploadRestoreInput(file);
                  }} />
                </label>
                <small>PNG、JPG 或 WebP，最大 10 MB</small>
              </fieldset>
            )}
            {tool !== "change_text" && <div className="wb-editor-operations">
              {activeOperations.map((item) => (
                <div key={item.operationId}>
                  <button type="button" className="wb-operation-edit" disabled={saving} onClick={() => switchTool(editorToolFor(item.type), item)}>{item.summary}</button>
                  <button type="button" disabled={saving} onClick={() => void removeOperation(item.operationId)}>移除</button>
                </div>
              ))}
            </div>}
          </aside>
          <footer className="wb-editor-footer">
            <span>{tool === "change_text" ? `已修改 ${textChanges.length} 条` : `已加入对话 ${activeOperations.length} 项`}</span>
            {tool === "change_text" && textEditLimitError && <strong role="alert">{textEditLimitError}</strong>}
            {editorError && <strong role="alert"><ModelSettingsMessage message={editorError} /></strong>}
            <button type="button" onClick={onClose}>取消</button>
            {activeOperationType && activeOperationType !== "change_text" && activeOperationType !== "restore_product" && <button type="button" disabled={saving || loadingDraft || !capabilityReady} onClick={() => void addOperation()}>{saving ? "保存中…" : activeOperations.some((item) => item.operationId === operationFor(activeOperationType).operationId) ? "更新对话操作" : "添加到对话"}</button>}
            {tool === "regenerate" ? (
              <button type="button" className="wb-primary-action" disabled={saving || !capabilityReady} onClick={() => { setSaving(true); onRegenerate().then(onClose).catch((errorValue) => setEditorError(errorValue instanceof Error ? errorValue.message : "再次生成失败")).finally(() => setSaving(false)); }}>{saving ? "提交中…" : "再次生成当前版本"}</button>
            ) : (
              <button
                type="button"
                className="wb-primary-action"
                disabled={saving || loadingDraft || !capabilityReady
                  || (tool === "change_text" && (!textChanges.length || translating || Boolean(textEditLimitError)))
                  || (tool === "restore_product" && (uploadingRestoreInput || (!restoreInput && !productInputs.length)))}
                onClick={() => void submit()}
              >
                {saving ? "提交中…" : tool === "re_edit" ? "生成" : tool === "restore_product" ? "还原商品" : "开始生成（新建编辑子卡）"}
              </button>
            )}
          </footer>
        </div>
      </section>
    </div>
  );
}
