import type { ModelChannelSnapshot } from "../shared/model-settings.js";
import { CHANGE_TEXT_MAX_LENGTH, CHANGE_TEXT_MAX_OPERATIONS, computeOutpaintCanvas, isOutpaintRatio, normalizeChangeTextReplacement, type OutpaintRatio } from "../shared/image-editor.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import type { PromptRepository, StorageAdapter } from "./types.js";

export const IMAGE_EDIT_TOOLS = ["re_edit", "regenerate", "add_text", "change_text", "redraw", "erase", "outpaint", "restore_product"] as const;
export type ImageEditTool = (typeof IMAGE_EDIT_TOOLS)[number];
export type ImageEditOperationType = Exclude<ImageEditTool, "regenerate">;

export type EditStatus = "draft" | "queued" | "generating" | "succeeded" | "failed";
export interface NormalizedRect { x: number; y: number; width: number; height: number; rotation?: number }
export interface NormalizedStroke { mode?: "draw" | "erase"; points: Array<{ x: number; y: number }>; width: number }
export interface MaskSnapshot { width: number; height: number; mimeType: "image/png"; sha256: string; objectKey: string; feather: number; strokes: NormalizedStroke[] }
export interface OcrTextBlock { id: string; text: string; confidence: number; bounds: NormalizedRect; rotation: number }
interface OcrProviderSnapshot { name: string; version: string; channel?: ModelChannelSnapshot }
interface EditProviderSnapshot extends OcrProviderSnapshot { capabilitiesVersion: string }

export interface OcrSnapshot { provider?: OcrProviderSnapshot; sourceVersionId: string; status: "succeeded" | "failed"; blocks: OcrTextBlock[]; error?: string }
export interface OutpaintSpec {
  targetRatio: OutpaintRatio;
  targetWidth: number;
  targetHeight: number;
  sourceOffset: { left: number; top: number };
}

export interface EditOperation {
  operationId: string;
  type: ImageEditOperationType;
  order: number;
  sourceCardId: string;
  sourceVersionId: string;
  parentVersionId: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface EditSnapshot {
  id: string;
  sourceCardId: string;
  sourceVersionId: string;
  parentVersionId: string;
  summary: string;
  sourcePrompt: string;
  tool?: ImageEditOperationType | null;
  attachedInputs?: ReadonlyArray<ImageEditAttachedInput>;
  maskApplied?: boolean | null;
  promptTemplateVersionId?: string | null;
  operations: ReadonlyArray<EditOperation>;
  provider: EditProviderSnapshot;
  createdAt: string;
  schemaVersion: "image-edit-snapshot-v1";
}

export interface ImageEditChildTask {
  id: string;
  sourceCardId: string;
  sourceVersionId: string;
  parentVersionId: string;
  snapshotId: string;
  summary: string;
  status: EditStatus;
  currentVersionId: string | null;
  finalVersionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageEditAttempt {
  id: string;
  childTaskId: string;
  snapshotId: string;
  attemptNo: number;
  status: Exclude<EditStatus, "draft" | "queued">;
  command: ImageEditCommand;
  provider: EditProviderSnapshot;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ImageEditVersion {
  id: string;
  childTaskId: string;
  attemptId: string;
  versionNumber: number;
  objectKey: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: string;
  createdAt: string;
}

export interface ImageEditCommand {
  type: ImageEditOperationType;
  sourceVersionId: string;
  prompt: string;
  operations: ReadonlyArray<EditOperation>;
  attachedInputs?: ReadonlyArray<ImageEditAttachedInput>;
  maskApplied?: boolean | null;
}

export interface ImageEditAttachedInput { objectKey: string; role: string }

const PRODUCT_INPUT_ROLES = new Set(["product", "product_primary", "product_detail"]);
const IMAGE_EDIT_INPUT_ROLES = "第 1 张为待编辑图，其余为商品外观依据，不得复制其背景与文字。下文提到的输入图顺序以此处声明为准。";
const RESTORE_INPUT_MAX_BYTES = 10 * 1024 * 1024;
const RESTORE_INPUT_FORMATS = new Map([["image/png", "png"], ["image/jpeg", "jpeg"], ["image/webp", "webp"]]);

export function imageEditProductInputs(inputImages: unknown): ImageEditAttachedInput[] {
  const productKeys = new Set<string>();
  for (const image of Array.isArray(inputImages) ? inputImages : []) {
    if (typeof image?.objectKey === "string" && image.objectKey.trim() && PRODUCT_INPUT_ROLES.has(image.role)) {
      productKeys.add(image.objectKey);
    }
  }
  return Array.from(productKeys, (objectKey) => ({ objectKey, role: "product" }));
}

export function declareImageEditInputs(prompt: string, inputs: ReadonlyArray<ImageEditAttachedInput>) {
  return inputs.length && !prompt.startsWith(IMAGE_EDIT_INPUT_ROLES) ? `${IMAGE_EDIT_INPUT_ROLES}\n${prompt}` : prompt;
}

export interface ImageEditProviderCapabilities {
  imageToImage: boolean;
  addText: boolean;
  changeText: boolean;
  redraw: boolean;
  erase: boolean;
  outpaint: boolean;
  currentVersionInput: boolean;
  ocr?: boolean;
}

export interface ImageEditProvider extends EditProviderSnapshot {
  capabilities(): Promise<ImageEditProviderCapabilities> | ImageEditProviderCapabilities;
  edit(command: ImageEditCommand, source: { bytes: Buffer; mimeType: string; width: number; height: number }): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number }>;
}

export interface OcrProvider extends OcrProviderSnapshot {
  recognize(source: ImageSource): Promise<{ blocks: OcrTextBlock[] }>;
}

export interface ImageSource {
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  generationPrompt?: string;
  productInputs?: ReadonlyArray<ImageEditAttachedInput>;
}

async function renderMaskPng(source: Pick<ImageSource, "width" | "height">, strokes: NormalizedStroke[], feather: number) {
  const paths = strokes.map((stroke) => {
    const points = stroke.points.map((point) => `${point.x * source.width},${point.y * source.height}`).join(" ");
    const width = Math.max(1, stroke.width * Math.min(source.width, source.height));
    const color = stroke.mode === "erase" ? "black" : "white";
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      return `<circle cx="${point.x * source.width}" cy="${point.y * source.height}" r="${width / 2}" fill="${color}"/>`;
    }
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}"><rect width="100%" height="100%" fill="black"/>${paths}</svg>`;
  const rendered = await sharp(Buffer.from(svg)).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = rendered.info;
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  // Use the painted area before feathering. Half coverage excludes antialiasing left after erasing.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rendered.data[y * width + x] < 128) continue;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = y + 1;
    }
  }
  if (left >= right || top >= bottom) throw new Error("MASK_SELECTION_REQUIRED");
  const region = { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height };
  const sigma = feather > 0 ? Math.max(0.3, feather * Math.min(width, height) / 12) : undefined;
  const output = sharp(rendered.data, { raw: { width, height, channels: 1 } }).toColourspace("b-w");
  if (sigma) output.blur(sigma);
  return { bytes: await output.png().toBuffer(), region };
}

type EditSubmission = { snapshot: EditSnapshot; childTask: ImageEditChildTask; attempt: ImageEditAttempt; duplicate: boolean };
export type EditDraft = { sessionId: string; operations: EditOperation[]; summary: string };
export type EditSubmissionInput = Omit<EditSubmission, "duplicate"> & {
  idempotencyKey: string;
  submittedDraft?: { sessionId: string; operations: EditOperation[] };
};

function matchesDraftOperation(left: EditOperation, right: EditOperation) {
  return left.operationId === right.operationId && left.sourceVersionId === right.sourceVersionId;
}

function withDraftOperations(draft: EditDraft, operations: EditOperation[], summary = draft.summary): EditDraft {
  return { ...draft, operations: operations.map((operation, index) => ({ ...operation, order: index + 1 })), summary };
}

export function upsertDraftOperation(draft: EditDraft, operation: EditOperation, summary?: string): EditDraft {
  const operations = [...draft.operations];
  const index = operations.findIndex((item) => matchesDraftOperation(item, operation));
  if (index >= 0) operations[index] = operation;
  else operations.push(operation);
  return withDraftOperations(draft, operations, summary);
}

export function removeDraftOperations(draft: EditDraft, operationIds: readonly string[], submitted?: readonly EditOperation[]): EditDraft {
  const operations = draft.operations.filter((item) => submitted
    ? !submitted.some((operation) => matchesDraftOperation(item, operation)
      && isDeepStrictEqual({ ...item, order: 0 }, { ...operation, order: 0 }))
    : !operationIds.includes(item.operationId));
  if (submitted && draft.operations.length - operations.length !== submitted.length) {
    throw new Error("EDIT_DRAFT_CHANGED");
  }
  return withDraftOperations(draft, operations, operations.map((operation) => operation.summary).join("；"));
}

export interface ImageEditorRepository {
  getSubmission(idempotencyKey: string): Promise<EditSubmission | null>;
  getDraft(sessionId: string): Promise<EditDraft | null>;
  upsertDraftOperation(sessionId: string, operation: EditOperation, summary?: string): Promise<EditDraft>;
  removeDraftOperations(sessionId: string, operationIds: readonly string[]): Promise<EditDraft | null>;
  getSnapshot(id: string): Promise<EditSnapshot | null>;
  getChildTask(id: string): Promise<ImageEditChildTask | null>;
  listChildTasks(): Promise<ImageEditChildTask[]>;
  listChildTasksBySourceCard(sourceCardId: string): Promise<ImageEditChildTask[]>;
  getOcrSnapshot(sessionId: string, sourceVersionId: string): Promise<OcrSnapshot | null>;
  saveOcrSnapshot(sessionId: string, snapshot: OcrSnapshot): Promise<void>;
  getAttempt(id: string): Promise<ImageEditAttempt | null>;
  submit(input: EditSubmissionInput): Promise<EditSubmission>;
  appendAttempt?(input: { idempotencyKey: string; snapshot: EditSnapshot; childTask: ImageEditChildTask; attempt: ImageEditAttempt }): Promise<EditSubmission>;
  completeAttempt(input: { attemptId: string; objectKey: string; sha256: string; width: number; height: number; mimeType: string; completedAt: string }): Promise<{ attempt: ImageEditAttempt; version: ImageEditVersion; childTask: ImageEditChildTask }>;
  failAttempt(attemptId: string, code: string, message: string, completedAt: string): Promise<{ attempt: ImageEditAttempt; childTask: ImageEditChildTask }>;
  listAttempts(childTaskId: string): Promise<ImageEditAttempt[]>;
  listVersions(childTaskId: string): Promise<ImageEditVersion[]>;
  selectVersion(childTaskId: string, versionId: string, selection: "current" | "final"): Promise<ImageEditVersion | null>;
  clearFinalVersions?(childTaskIds: string[]): Promise<void>;
}

export class MemoryImageEditorRepository implements ImageEditorRepository {
  private drafts = new Map<string, EditDraft>();
  private snapshots = new Map<string, EditSnapshot>();
  private tasks = new Map<string, ImageEditChildTask>();
  private attempts = new Map<string, ImageEditAttempt>();
  private versions = new Map<string, ImageEditVersion>();
  private idempotency = new Map<string, { snapshotId: string; childTaskId: string; attemptId: string }>();
  private ocr = new Map<string, OcrSnapshot>();
  async getDraft(id: string) { const draft = this.drafts.get(id); return draft ? structuredClone(draft) : null; }
  async upsertDraftOperation(sessionId: string, operation: EditOperation, summary?: string) {
    const draft = upsertDraftOperation(this.drafts.get(sessionId) ?? { sessionId, operations: [], summary: "" }, operation, summary);
    this.drafts.set(sessionId, structuredClone(draft));
    return draft;
  }
  async removeDraftOperations(sessionId: string, operationIds: readonly string[]) {
    const draft = this.drafts.get(sessionId);
    if (!draft) return null;
    const updated = removeDraftOperations(draft, operationIds);
    this.drafts.set(sessionId, structuredClone(updated));
    return updated;
  }
  async getSnapshot(id: string) { const snapshot = this.snapshots.get(id); return snapshot ? structuredClone(snapshot) : null; }
  async getChildTask(id: string) { const task = this.tasks.get(id); return task ? structuredClone(task) : null; }
  async listChildTasks() { return [...this.tasks.values()].map((task) => structuredClone(task)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async listChildTasksBySourceCard(sourceCardId: string) { return [...this.tasks.values()].filter((task) => task.sourceCardId === sourceCardId).map((task) => structuredClone(task)); }
  async getOcrSnapshot(sessionId: string, sourceVersionId: string) { const value = this.ocr.get(`${sessionId}:${sourceVersionId}`); return value ? structuredClone(value) : null; }
  async saveOcrSnapshot(sessionId: string, snapshot: OcrSnapshot) { this.ocr.set(`${sessionId}:${snapshot.sourceVersionId}`, structuredClone(snapshot)); }
  async getAttempt(id: string) { const attempt = this.attempts.get(id); return attempt ? structuredClone(attempt) : null; }
  async getSubmission(idempotencyKey: string) {
    const old = this.idempotency.get(idempotencyKey);
    if (!old) return null;
    return structuredClone({ snapshot: this.snapshots.get(old.snapshotId)!, childTask: this.tasks.get(old.childTaskId)!, attempt: this.attempts.get(old.attemptId)!, duplicate: true });
  }
  async submit({ submittedDraft, ...input }: EditSubmissionInput) {
    const old = this.idempotency.get(input.idempotencyKey);
    if (old) return { snapshot: this.snapshots.get(old.snapshotId)!, childTask: this.tasks.get(old.childTaskId)!, attempt: this.attempts.get(old.attemptId)!, duplicate: true };
    if (submittedDraft) {
      const draft = this.drafts.get(submittedDraft.sessionId);
      if (!draft) throw new Error("EDIT_DRAFT_CHANGED");
      this.drafts.set(draft.sessionId, removeDraftOperations(draft, [], submittedDraft.operations));
    }
    this.snapshots.set(input.snapshot.id, structuredClone(input.snapshot));
    this.tasks.set(input.childTask.id, structuredClone(input.childTask));
    this.attempts.set(input.attempt.id, structuredClone(input.attempt));
    this.idempotency.set(input.idempotencyKey, { snapshotId: input.snapshot.id, childTaskId: input.childTask.id, attemptId: input.attempt.id });
    return { ...input, duplicate: false };
  }
  async appendAttempt(input: { idempotencyKey: string; snapshot: EditSnapshot; childTask: ImageEditChildTask; attempt: ImageEditAttempt }) {
    const old = this.idempotency.get(input.idempotencyKey);
    if (old) return { snapshot: this.snapshots.get(old.snapshotId)!, childTask: this.tasks.get(old.childTaskId)!, attempt: this.attempts.get(old.attemptId)!, duplicate: true };
    if (!this.snapshots.has(input.snapshot.id) || !this.tasks.has(input.childTask.id)) throw new Error("INVALID_IMAGE_EDIT_TASK");
    const attemptNo = [...this.attempts.values()].filter((item) => item.childTaskId === input.childTask.id).reduce((max, item) => Math.max(max, item.attemptNo), 0) + 1;
    const attempt = { ...input.attempt, attemptNo };
    this.attempts.set(attempt.id, structuredClone(attempt));
    this.tasks.set(input.childTask.id, structuredClone(input.childTask));
    this.idempotency.set(input.idempotencyKey, { snapshotId: input.snapshot.id, childTaskId: input.childTask.id, attemptId: attempt.id });
    return { snapshot: input.snapshot, childTask: input.childTask, attempt, duplicate: false };
  }
  async completeAttempt(input: { attemptId: string; objectKey: string; sha256: string; width: number; height: number; mimeType: string; completedAt: string }) {
    const attempt = this.attempts.get(input.attemptId); if (!attempt || attempt.status !== "generating") throw new Error("INVALID_IMAGE_EDIT_ATTEMPT");
    const task = this.tasks.get(attempt.childTaskId); if (!task) throw new Error("INVALID_IMAGE_EDIT_TASK");
    const versions = await this.listVersions(task.id); const version: ImageEditVersion = { id: randomUUID(), childTaskId: task.id, attemptId: attempt.id, versionNumber: versions.length + 1, objectKey: input.objectKey, sha256: input.sha256, width: input.width, height: input.height, mimeType: input.mimeType, createdAt: input.completedAt };
    this.versions.set(version.id, version);
    const done = { ...attempt, status: "succeeded" as const, completedAt: input.completedAt }; this.attempts.set(attempt.id, done);
    const updated = { ...task, status: "succeeded" as const, currentVersionId: version.id, updatedAt: input.completedAt }; this.tasks.set(task.id, updated);
    return { attempt: done, version, childTask: updated };
  }
  async failAttempt(id: string, code: string, message: string, completedAt: string) {
    const attempt = this.attempts.get(id); if (!attempt) throw new Error("INVALID_IMAGE_EDIT_ATTEMPT"); const task = this.tasks.get(attempt.childTaskId); if (!task) throw new Error("INVALID_IMAGE_EDIT_TASK");
    const failed = { ...attempt, status: "failed" as const, errorCode: code, errorMessage: message, completedAt }; this.attempts.set(id, failed);
    const updated = { ...task, status: "failed" as const, errorCode: code, errorMessage: message, updatedAt: completedAt }; this.tasks.set(task.id, updated); return { attempt: failed, childTask: updated };
  }
  async listAttempts(childTaskId: string) { return [...this.attempts.values()].filter((a) => a.childTaskId === childTaskId).sort((a, b) => a.attemptNo - b.attemptNo); }
  async listVersions(childTaskId: string) { return [...this.versions.values()].filter((v) => v.childTaskId === childTaskId).sort((a, b) => b.versionNumber - a.versionNumber); }
  async selectVersion(childTaskId: string, versionId: string, selection: "current" | "final") { const version = this.versions.get(versionId); if (!version || version.childTaskId !== childTaskId) return null; const task = this.tasks.get(childTaskId); if (!task) return null; if (selection === "final") { const attempt = this.attempts.get(version.attemptId); if (!attempt || attempt.status !== "succeeded") throw new Error("VERSION_NOT_ELIGIBLE_FOR_FINAL"); }
    if (selection === "current") this.tasks.set(childTaskId, { ...task, currentVersionId: version.id, updatedAt: new Date().toISOString() }); else this.tasks.set(childTaskId, { ...task, finalVersionId: version.id, updatedAt: new Date().toISOString() }); return version;
  }
  async clearFinalVersions(childTaskIds: string[]) {
    const now = new Date().toISOString();
    for (const childTaskId of childTaskIds) {
      const task = this.tasks.get(childTaskId);
      if (task && task.finalVersionId !== null) {
        this.tasks.set(childTaskId, { ...task, finalVersionId: null, updatedAt: now });
      }
    }
  }
}

export function formatOcrErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  const isAbort =
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    trimmed === "OCR_TIMEOUT" ||
    /\b(timeout|timed out|abort(ed)?)\b/i.test(trimmed);
  if (isAbort) {
    return "文字识别请求超时，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  const isNetwork =
    (error instanceof TypeError && /fetch/i.test(trimmed)) ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(trimmed);
  if (isNetwork) {
    return "文字识别服务连接失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (trimmed === "OCR_PROVIDER_UNAVAILABLE") {
    return "当前未配置多模态识字模型，请在图片上拖拽框选原文字区域并手动输入原文字与新文字";
  }
  if (trimmed === "SOURCE_VERSION_NOT_FOUND") {
    return "未找到待识别的图片版本，请刷新画布后重试";
  }
  const httpMatch = trimmed.match(/^OCR_HTTP_(\d+)$/);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code === 401 || code === 403) {
      return `文字识别服务鉴权失败（HTTP ${code}），请检查模型配置或手动框选改字`;
    }
    if (code === 413) {
      return "识别图片体积过大（HTTP 413），请点击重新识别或手动框选改字";
    }
    if (code === 429) {
      return "文字识别请求过于频繁（HTTP 429），请稍后重试或手动框选改字";
    }
    return `文字识别服务返回异常（HTTP ${code}），可点击重新识别或手动框选改字`;
  }
  if (trimmed === "OCR_EMPTY_RESPONSE") {
    return "文字识别模型未返回内容，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (trimmed === "OCR_INVALID_HTTP_RESPONSE" || trimmed === "OCR_INVALID_JSON_RESPONSE") {
    return "文字识别响应格式异常，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
  }
  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    return trimmed;
  }
  return "文字识别失败，可点击重新识别，或直接在图片上框选并手动输入原文字与新文字";
}

function describeNormalizedRegion(region: unknown): string {
  if (!region || typeof region !== "object") return "指定区域";
  const r = region as Record<string, unknown>;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return "指定区域";
  const cx = x + width / 2;
  const cy = y + height / 2;
  const vertical = cy < 0.33 ? "顶部" : cy > 0.67 ? "底部" : "中部";
  const horizontal = cx < 0.33 ? "左侧" : cx > 0.67 ? "右侧" : "居中";
  const xStart = Math.round(x * 100);
  const xEnd = Math.round((x + width) * 100);
  const yStart = Math.round(y * 100);
  const yEnd = Math.round((y + height) * 100);
  return `${vertical}${horizontal}区域（横向约 ${xStart}%–${xEnd}%，纵向约 ${yStart}%–${yEnd}%）`;
}

const OUTPAINT_DIRECTION_LABELS = {
  all: "四周",
  horizontal: "左右",
  vertical: "上下",
  left: "左侧",
  right: "右侧",
};

const EDIT_PAYLOAD_FIELDS: Record<ImageEditOperationType, readonly string[]> = {
  re_edit: ["prompt"],
  add_text: ["text", "region", "prompt"],
  change_text: ["originalText", "newText", "region", "prompt"],
  redraw: ["strokes", "feather", "prompt"],
  erase: ["strokes", "feather", "prompt"],
  outpaint: ["direction", "targetRatio", "targetWidth", "targetHeight", "prompt"],
  restore_product: ["referenceObjectKeys"],
};

const IMAGE_EDIT_PROMPT_HEADER = "严格保持输入图片中的商品主体外观、结构比例、材质细节、光影色调、背景构图及未指定修改的文字与元素不变，仅执行以下局部修改：";
const CHANGE_TEXT_INSTRUCTION = "仅编辑下列文字。按原文字和位置找到每一条，准确替换为 newText，保持原有排版、字体风格、颜色、透视与光影。newText 为空时移除原文字，用周围背景自然填补，延续纹理和光影。坐标相对整张图归一化，以左上角为原点。";
const RESTORE_PRODUCT_HEADER = "仅修正待编辑图中的商品外观，保持原图的构图、背景、文字、版式和光影不变。";
const IMAGE_EDIT_INSTRUCTIONS = {
  add_text: "在{{region}}新增文字“{{text}}”{{requirement}}。",
  redraw: "仅重绘{{region}}{{requirement}}，选区以外的商品与背景画面严格保持不变。",
  erase: "仅消除{{region}}中的目标并自然补全周围背景{{requirement}}，选区以外画面严格保持不变。",
  outpaint: "仅补全灰色扩展区，自然延续原图边缘的背景纹理、光影与透视，保持原图画面不变{{requirement}}。",
  restore_product: "以提供的商品外观依据图还原商品的形状、结构比例、颜色、材质、细节和可见标识，保持商品在原构图中的位置和视角。不可补造依据图无法确认的配件、标识或细节。",
};

function buildChangeTextPrompt(
  operations: ReadonlyArray<EditOperation>,
  template?: { body: string; userPromptTemplate: string } | null,
): string {
  const customInstruction = template?.userPromptTemplate;
  const legacyTemplate = customInstruction?.match(/\{\{(?:region|originalText|newText|requirement)\}\}/) ? customInstruction : undefined;
  const changes = operations.map(({ payload }) => {
    const { x, y, width, height, rotation } = payload.region as NormalizedRect;
    return {
      originalText: String(payload.originalText),
      newText: normalizeChangeTextReplacement(String(payload.newText)),
      boundingBox: {
        x: Number(x), y: Number(y), width: Number(width), height: Number(height),
        ...(typeof rotation === "number" && Number.isFinite(rotation) ? { rotation } : {}),
      },
    };
  });
  const positions = changes.map(({ originalText, newText, boundingBox }, index) => {
    const region = describeNormalizedRegion(boundingBox);
    if (newText === "") return `${index + 1}. ${region}：移除原文字，用周围背景自然填补。`;
    const prompt = operations[index].payload.prompt;
    const requirement = typeof prompt === "string" && prompt.trim() ? `（${prompt.trim()}）` : "";
    const values = { region, originalText, newText, requirement };
    const replacement = legacyTemplate
      ? legacyTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: keyof typeof values) => values[key] ?? "")
      : `将原文字“${originalText}”替换为“${newText}”${requirement}。`;
    return `${index + 1}. ${region}：${replacement}`;
  });
  return [
    template?.body ?? IMAGE_EDIT_PROMPT_HEADER,
    legacyTemplate ? CHANGE_TEXT_INSTRUCTION : customInstruction || CHANGE_TEXT_INSTRUCTION,
    JSON.stringify(changes, null, 2),
    "文字位置：",
    ...positions,
  ].join("\n");
}

export function buildImageEditPrompt(
  operations: ReadonlyArray<EditOperation>,
  sourcePrompt: string,
  template?: { body: string; userPromptTemplate: string } | null,
): string {
  if (operations.length === 1 && operations[0].type === "re_edit") {
    return String(operations[0].payload.prompt ?? sourcePrompt);
  }
  if (operations[0]?.type === "change_text") return buildChangeTextPrompt(operations, template);
  const instructions = operations.map((operation, index) => {
    const prefix = operations.length > 1 ? `${index + 1}. ` : "";
    const req = typeof operation.payload.prompt === "string" ? operation.payload.prompt.trim() : "";
    const requirement = req ? `（${req}）` : "";
    const render = (instruction: string, values: Record<string, string>) => prefix
      + instruction.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
    switch (operation.type) {
      case "add_text":
        return render(template?.userPromptTemplate || IMAGE_EDIT_INSTRUCTIONS.add_text, {
          region: operation.payload.region ? describeNormalizedRegion(operation.payload.region) : "画面指定区域",
          text: String(operation.payload.text ?? "").trim(),
          requirement: req ? `，排版与视觉要求：${req}` : "",
        });
      case "redraw":
      case "erase": {
        const region = describeNormalizedRegion(operation.payload.region);
        const instruction = (template?.userPromptTemplate || IMAGE_EDIT_INSTRUCTIONS[operation.type])
          .replaceAll("蒙版白色选区", "{{region}}")
          .replaceAll("蒙版以外", "选区以外");
        const selection = instruction.includes("{{region}}") ? "" : `选区为${region}。\n`;
        return selection + render(instruction, { region, requirement: operation.type === "redraw" && req ? `：${req}` : requirement });
      }
      case "outpaint": {
        const { targetRatio, targetWidth, targetHeight } = operation.payload;
        const direction = OUTPAINT_DIRECTION_LABELS[operation.payload.direction as keyof typeof OUTPAINT_DIRECTION_LABELS];
        const dimensions = `，画布尺寸 ${targetWidth}×${targetHeight}`;
        const framing = `待编辑图已扩边至 ${targetRatio}${dimensions}，原图居中，周围的灰色填充区域是唯一要编辑的区域。`;
        const focus = direction && direction !== "四周" ? `如${direction}有灰色扩展区，优先延续该方向的构图。` : "";
        return `${framing}${focus}\n${render(template?.userPromptTemplate || IMAGE_EDIT_INSTRUCTIONS.outpaint, {
          direction: `向${direction ?? "四周"}`, ratio: String(targetRatio), dimensions, anchor: "居中", requirement,
        })}`;
      }
      case "re_edit":
        return `${prefix}${req || operation.summary}`;
      case "restore_product":
        return render(template?.userPromptTemplate || IMAGE_EDIT_INSTRUCTIONS.restore_product, {});
    }
  });
  const header = operations[0]?.type === "restore_product" ? RESTORE_PRODUCT_HEADER : IMAGE_EDIT_PROMPT_HEADER;
  return [template?.body ?? header, ...instructions].filter(Boolean).join("\n");
}

function editProviderSnapshot({ name, version, capabilitiesVersion, channel }: ImageEditProvider): EditProviderSnapshot {
  return { name, version, capabilitiesVersion, channel };
}

export class ImageEditorService {
  constructor(
    private readonly repository: ImageEditorRepository,
    private readonly provider: ImageEditProvider | (() => Promise<ImageEditProvider | null>),
    private readonly storage: StorageAdapter,
    private readonly resolveSource: (versionId: string) => Promise<ImageSource | null>,
    private readonly ocrProvider?: OcrProvider | (() => Promise<OcrProvider | null>),
    private readonly validateSource?: (sourceCardId: string, sourceVersionId: string) => Promise<boolean>,
    private readonly prompts?: PromptRepository,
    private readonly resolveProductInputs?: (versionId: string) => Promise<ReadonlyArray<ImageEditAttachedInput> | null>,
  ) {}

  private async requireProvider() {
    const provider = typeof this.provider === "function" ? await this.provider() : this.provider;
    if (!provider) throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
    return provider;
  }

  private async resolveOcrProvider() {
    return typeof this.ocrProvider === "function" ? this.ocrProvider() : this.ocrProvider;
  }

  async capabilities() {
    const [provider, ocr] = await Promise.all([
      typeof this.provider === "function" ? this.provider() : this.provider,
      this.resolveOcrProvider(),
    ]);
    return {
      provider: provider ? editProviderSnapshot(provider) : null,
      capabilities: { ...(await provider?.capabilities()), ocr: Boolean(ocr) },
    };
  }

  async getDraft(sessionId: string) { return this.repository.getDraft(sessionId); }

  async getSession(sessionId: string, sourceVersionId: string) {
    const productInputs = await this.getSessionProductInputs(sessionId, sourceVersionId);
    const draft = await this.getDraft(sessionId);
    return {
      sessionId, operations: draft?.operations ?? [], summary: draft?.summary ?? "",
      productInputs: productInputs.map(({ objectKey }) => this.restoreInputView(sessionId, sourceVersionId, objectKey)),
    };
  }

  async uploadRestoreInput(sessionId: string, sourceVersionId: string, bytes: Buffer, mimeType: string) {
    const format = RESTORE_INPUT_FORMATS.get(mimeType);
    if (!format || !bytes.length) throw new Error("RESTORE_PRODUCT_IMAGE_INVALID");
    if (bytes.length > RESTORE_INPUT_MAX_BYTES) throw new Error("RESTORE_PRODUCT_IMAGE_TOO_LARGE");
    await this.assertSessionSource(sessionId, sourceVersionId);
    try {
      const image = sharp(bytes);
      if ((await image.metadata()).format !== format) throw new Error("RESTORE_PRODUCT_IMAGE_INVALID");
      await image.resize(1, 1).toBuffer();
    } catch {
      throw new Error("RESTORE_PRODUCT_IMAGE_INVALID");
    }
    const objectKey = `${this.restoreUploadPrefix(sessionId, sourceVersionId)}${randomUUID()}.${format}`;
    await this.storage.put({ key: objectKey, bytes, contentType: mimeType });
    return this.restoreInputView(sessionId, sourceVersionId, objectKey);
  }

  async restoreInputThumbnail(sessionId: string, sourceVersionId: string, objectKey: string) {
    const productInputs = await this.getSessionProductInputs(sessionId, sourceVersionId);
    if (!productInputs.some((input) => input.objectKey === objectKey) && !this.isRestoreUpload(sessionId, sourceVersionId, objectKey)) {
      throw new Error("RESTORE_PRODUCT_REFERENCE_INVALID");
    }
    const stored = await this.storage.get(objectKey);
    if (!stored) throw new Error("RESTORE_PRODUCT_REFERENCE_INVALID");
    return sharp(stored.bytes).rotate().resize(160, 160, { fit: "inside", withoutEnlargement: true }).webp().toBuffer();
  }

  private async assertSessionSource(sessionId: string, sourceVersionId: string) {
    if (!sessionId || !sourceVersionId || (this.validateSource && !(await this.validateSource(sessionId, sourceVersionId)))) {
      throw new Error("EDIT_SOURCE_NOT_FOUND");
    }
  }

  private async getSessionProductInputs(sessionId: string, sourceVersionId: string) {
    await this.assertSessionSource(sessionId, sourceVersionId);
    if (this.resolveProductInputs) {
      const inputs = await this.resolveProductInputs(sourceVersionId);
      if (!inputs) throw new Error("SOURCE_VERSION_NOT_FOUND");
      return inputs;
    }
    const source = await this.resolveSource(sourceVersionId);
    if (!source) throw new Error("SOURCE_VERSION_NOT_FOUND");
    return source.productInputs ?? [];
  }

  private restoreUploadPrefix(sessionId: string, sourceVersionId: string) {
    return `image-edits/sessions/${encodeURIComponent(sessionId)}/versions/${encodeURIComponent(sourceVersionId)}/restore-inputs/`;
  }

  private isRestoreUpload(sessionId: string, sourceVersionId: string, objectKey: string) {
    const prefix = this.restoreUploadPrefix(sessionId, sourceVersionId);
    return objectKey.startsWith(prefix) && /^[0-9a-f-]{36}\.(png|jpeg|webp)$/.test(objectKey.slice(prefix.length));
  }

  private restoreInputView(sessionId: string, sourceVersionId: string, objectKey: string) {
    const base = `/api/image-editor/sessions/${encodeURIComponent(sessionId)}/versions/${encodeURIComponent(sourceVersionId)}/restore-inputs`;
    return { objectKey, thumbnailUrl: `${base}/${encodeURIComponent(objectKey)}/thumbnail` };
  }

  private async resolveRestoreInputs(sessionId: string, source: ImageSource, operation: EditOperation) {
    const available = source.productInputs ?? [];
    const requested = operation.payload.referenceObjectKeys;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length !== 1 ||
      typeof requested[0] !== "string" || !requested[0])) {
      throw new Error("RESTORE_PRODUCT_REFERENCE_INVALID");
    }
    if (requested === undefined) {
      if (!available.length) throw new Error("RESTORE_PRODUCT_REFERENCE_REQUIRED");
      return available;
    }
    const objectKey = requested[0];
    const candidate = available.find((input) => input.objectKey === objectKey);
    if (candidate) return [candidate];
    if (this.isRestoreUpload(sessionId, operation.sourceVersionId, objectKey) && await this.storage.get(objectKey)) {
      return [{ objectKey, role: "product" }];
    }
    throw new Error("RESTORE_PRODUCT_REFERENCE_INVALID");
  }

  async recognize(sessionId: string, sourceVersionId: string) {
    const ocr = await this.resolveOcrProvider();
    if (!ocr) throw new Error("OCR_PROVIDER_UNAVAILABLE");
    const source = await this.resolveSource(sourceVersionId);
    if (!source) throw new Error("SOURCE_VERSION_NOT_FOUND");
    const provider = { name: ocr.name, version: ocr.version, channel: ocr.channel };
    let snapshot: OcrSnapshot;
    try {
      snapshot = { sourceVersionId, provider, status: "succeeded", blocks: (await ocr.recognize(source)).blocks };
    } catch (error) {
      snapshot = { sourceVersionId, provider, status: "failed", blocks: [], error: formatOcrErrorMessage(error) };
    }
    await this.repository.saveOcrSnapshot(sessionId, snapshot);
    return snapshot;
  }
  async getOcrSnapshot(sessionId: string, sourceVersionId: string) { return this.repository.getOcrSnapshot(sessionId, sourceVersionId); }
  async upsertOperation(input: { sessionId: string; operation: EditOperation; summary?: string }) {
    return this.repository.upsertDraftOperation(input.sessionId, input.operation, input.summary);
  }
  async removeOperation(sessionId: string, operationId: string) {
    return this.repository.removeDraftOperations(sessionId, [operationId]);
  }
  private async resolveEditPrompt(tool: ImageEditOperationType) {
    if (!this.prompts || tool === "re_edit") return null;
    const published = await this.prompts.listPublished("task_image");
    const matching = published.find((item) => item.code === `image-editor.${tool}`);
    if (!matching) throw new Error("IMAGE_EDIT_PROMPT_TEMPLATE_UNAVAILABLE");
    const template = await this.prompts.getPublishedVersion(matching.templateVersionId, "task_image");
    if (!template) throw new Error("IMAGE_EDIT_PROMPT_TEMPLATE_UNAVAILABLE");
    return template;
  }
  async submit(input: {
    sessionId: string; idempotencyKey: string; sourceCardId: string; sourceVersionId: string;
    parentVersionId?: string; summary?: string; tool?: string; operationIds?: readonly string[];
  }) {
    const existing = await this.repository.getSubmission(input.idempotencyKey);
    if (existing) return existing;
    if (!input.sourceCardId.trim() || !input.sourceVersionId.trim()) throw new Error("EDIT_SOURCE_VERSION_REQUIRED");
    if (input.tool !== undefined && (!IMAGE_EDIT_TOOLS.some((tool) => tool === input.tool) || input.tool === "regenerate")) {
      throw new Error("INVALID_IMAGE_EDIT_TOOL");
    }
    const draft = await this.repository.getDraft(input.sessionId);
    const versionOperations = draft?.operations.filter((operation) => operation.sourceVersionId === input.sourceVersionId) ?? [];
    const selected = new Set(input.operationIds);
    const draftOperations = input.operationIds
      ? versionOperations.filter((operation) => selected.has(operation.operationId))
      : versionOperations.filter((operation) => !input.tool || operation.type === input.tool);
    if (!draftOperations.length || (input.operationIds && draftOperations.length !== selected.size)) {
      const duplicate = await this.repository.getSubmission(input.idempotencyKey);
      if (duplicate) return duplicate;
      throw new Error(draftOperations.length ? "EDIT_DRAFT_CHANGED" : "EDIT_OPERATIONS_REQUIRED");
    }
    const tool = input.tool ?? draftOperations[0].type;
    if (draftOperations.some((operation) => operation.type !== tool)) throw new Error("MIXED_IMAGE_EDIT_TOOLS");
    if (draftOperations.length > 1 && tool !== "add_text" && tool !== "change_text") {
      throw new Error(tool === "redraw" || tool === "erase" ? "MULTIPLE_MASK_OPERATIONS_UNSUPPORTED" : "MULTIPLE_IMAGE_EDIT_OPERATIONS_UNSUPPORTED");
    }
    if (this.validateSource && !(await this.validateSource(input.sourceCardId, input.sourceVersionId))) throw new Error("EDIT_SOURCE_NOT_FOUND");
    const source = await this.resolveSource(input.sourceVersionId); if (!source) throw new Error("SOURCE_VERSION_NOT_FOUND");
    const provider = await this.requireProvider();
    const sourcePrompt = source.generationPrompt ?? "";
    const selectedOperations = draftOperations.map((operation, index) => {
      if (!Object.hasOwn(EDIT_PAYLOAD_FIELDS, operation.type) || !operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
        throw new Error("INVALID_IMAGE_EDIT_OPERATION");
      }
      const payload = Object.fromEntries(EDIT_PAYLOAD_FIELDS[operation.type]
        .filter((field) => Object.hasOwn(operation.payload, field))
        .map((field) => [field, operation.payload[field]]));
      return { ...operation, order: index + 1, sourceCardId: input.sourceCardId, sourceVersionId: input.sourceVersionId, parentVersionId: input.parentVersionId ?? input.sourceVersionId, payload };
    });
    const caps = await provider.capabilities();
    this.assertCapabilities(selectedOperations, caps);
    for (const operation of selectedOperations) this.validateOperation(operation);
    const operations = tool === "change_text"
      ? selectedOperations.filter(({ payload }) => payload.originalText !== payload.newText)
      : selectedOperations;
    if (!operations.length) throw new Error("EDIT_OPERATIONS_REQUIRED");
    if (tool === "change_text") {
      if (operations.length > CHANGE_TEXT_MAX_OPERATIONS) throw new Error("CHANGE_TEXT_TOO_MANY_OPERATIONS");
      const ocr = await this.repository.getOcrSnapshot(input.sessionId, input.sourceVersionId);
      operations.forEach((operation, index) => {
        operation.order = index + 1;
        operation.payload.newText = normalizeChangeTextReplacement(String(operation.payload.newText));
        if (ocr) operation.payload.ocrSnapshot = structuredClone(ocr);
      });
    }
    const operationType = operations[0].type;
    const attachedInputs = operationType === "restore_product"
      ? await this.resolveRestoreInputs(input.sessionId, source, operations[0])
      : ["re_edit", "redraw", "outpaint"].includes(operationType) ? source.productInputs ?? [] : [];
    const template = await this.resolveEditPrompt(operationType);
    const materialized = await Promise.all(operations.map(async (operation) => {
      const payload = { ...operation.payload };
      if (operation.type === "restore_product") {
        payload.referenceObjectKeys = attachedInputs.map((input) => input.objectKey);
      }
      if (operation.type === "outpaint") {
        const direction = payload.direction;
        const targetRatio = payload.targetRatio;
        if (typeof direction !== "string" || !Object.hasOwn(OUTPAINT_DIRECTION_LABELS, direction)) throw new Error("OUTPAINT_DIRECTION_INVALID");
        if (!isOutpaintRatio(targetRatio)) throw new Error("OUTPAINT_TARGET_RATIO_INVALID");
        const dimensions = computeOutpaintCanvas(source.width, source.height, targetRatio);
        if (payload.targetWidth !== undefined && Number(payload.targetWidth) !== dimensions.targetWidth) throw new Error("OUTPAINT_TARGET_DIMENSIONS_INVALID");
        if (payload.targetHeight !== undefined && Number(payload.targetHeight) !== dimensions.targetHeight) throw new Error("OUTPAINT_TARGET_DIMENSIONS_INVALID");
        payload.targetWidth = dimensions.targetWidth;
        payload.targetHeight = dimensions.targetHeight;
        payload.sourceOffset = dimensions.sourceOffset;
        payload.anchor = "center";
      }
      if (operation.type === "redraw" || operation.type === "erase") {
        const strokes = operation.payload.strokes as NormalizedStroke[];
        const feather = operation.payload.feather === undefined ? 0 : Number(operation.payload.feather);
        if (!Number.isFinite(feather) || feather < 0 || feather > 1) throw new Error("MASK_FEATHER_INVALID");
        const { bytes, region } = await renderMaskPng(source, strokes, feather);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const objectKey = `image-edits/masks/${operation.sourceVersionId}/${operation.operationId}-${sha256}.png`;
        await this.storage.put({ key: objectKey, bytes, contentType: "image/png" });
        payload.feather = feather;
        payload.region = region;
        payload.mask = { width: source.width, height: source.height, mimeType: "image/png", sha256, objectKey, feather, strokes: structuredClone(strokes) } satisfies MaskSnapshot;
      }
      return { ...operation, payload };
    }));
    const summary = (selectedOperations.length === operations.length ? input.summary : undefined)
      ?? operations.map((operation) => operation.summary).join("；");
    const prompt = declareImageEditInputs(buildImageEditPrompt(materialized, sourcePrompt, template), attachedInputs);
    const snapshot: EditSnapshot = {
      id: randomUUID(), sourceCardId: input.sourceCardId, sourceVersionId: input.sourceVersionId,
      parentVersionId: input.parentVersionId ?? input.sourceVersionId, summary, sourcePrompt, tool: materialized[0].type,
      attachedInputs: structuredClone(attachedInputs), maskApplied: false,
      promptTemplateVersionId: template?.templateVersionId ?? null,
      operations: structuredClone(materialized), provider: editProviderSnapshot(provider),
      createdAt: new Date().toISOString(), schemaVersion: "image-edit-snapshot-v1",
    };
    const taskId = randomUUID(); const now = new Date().toISOString(); const childTask: ImageEditChildTask = { id: taskId, sourceCardId: input.sourceCardId, sourceVersionId: snapshot.sourceVersionId, parentVersionId: snapshot.parentVersionId, snapshotId: snapshot.id, summary: snapshot.summary, status: "generating", currentVersionId: null, finalVersionId: null, errorCode: null, errorMessage: null, createdAt: now, updatedAt: now };
    const command: ImageEditCommand = {
      type: materialized[0].type, sourceVersionId: snapshot.sourceVersionId, prompt,
      operations: snapshot.operations, attachedInputs: snapshot.attachedInputs, maskApplied: snapshot.maskApplied,
    };
    const attempt: ImageEditAttempt = { id: randomUUID(), childTaskId: taskId, snapshotId: snapshot.id, attemptNo: 1, status: "generating", command, provider: snapshot.provider, errorCode: null, errorMessage: null, createdAt: now, completedAt: null };
    const result = await this.repository.submit({
      idempotencyKey: input.idempotencyKey, snapshot, childTask, attempt,
      submittedDraft: { sessionId: input.sessionId, operations: draftOperations },
    });
    if (!result.duplicate) void this.execute(result.attempt, provider);
    return result;
  }
  async retry(attemptId: string, idempotencyKey: string) {
    const existing = await this.repository.getSubmission(idempotencyKey);
    if (existing) return existing;
    const failed = await this.repository.getAttempt(attemptId);
    if (!failed || failed.status !== "failed") throw new Error("INVALID_IMAGE_EDIT_ATTEMPT");
    const task = await this.repository.getChildTask(failed.childTaskId);
    if (!task) throw new Error("INVALID_IMAGE_EDIT_TASK");
    const snapshot = await this.repository.getSnapshot(task.snapshotId);
    if (!snapshot) throw new Error("INVALID_IMAGE_EDIT_SNAPSHOT");
    const provider = await this.requireProvider();
    this.assertCapabilities(failed.command.operations, await provider.capabilities());
    const oldAttempts = await this.repository.listAttempts(task.id);
    const attempt: ImageEditAttempt = {
      ...failed, id: randomUUID(), attemptNo: oldAttempts.length + 1, status: "generating",
      provider: editProviderSnapshot(provider), errorCode: null, errorMessage: null,
      createdAt: new Date().toISOString(), completedAt: null,
    };
    const childTask = { ...task, status: "generating" as const, errorCode: null, errorMessage: null, updatedAt: attempt.createdAt };
    const result = await this.appendAttempt({ idempotencyKey, snapshot, childTask, attempt });
    if (!result.duplicate) void this.execute(result.attempt, provider);
    return result;
  }

  async regenerate(input: { childTaskId: string; idempotencyKey: string }) {
    const existing = await this.repository.getSubmission(input.idempotencyKey);
    if (existing) return existing;
    const task = await this.repository.getChildTask(input.childTaskId);
    if (!task) throw new Error("INVALID_IMAGE_EDIT_TASK");
    if (!task.currentVersionId) throw new Error("CURRENT_VERSION_REQUIRED");
    const snapshot = await this.repository.getSnapshot(task.snapshotId);
    if (!snapshot) throw new Error("INVALID_IMAGE_EDIT_SNAPSHOT");
    const provider = await this.requireProvider();
    if (!(await this.resolveSource(snapshot.sourceVersionId))) throw new Error("SOURCE_VERSION_NOT_FOUND");
    const attempts = await this.repository.listAttempts(task.id);
    const original = attempts[0];
    if (!original || !snapshot.operations.length) throw new Error("INVALID_IMAGE_EDIT_SNAPSHOT");
    const command: ImageEditCommand = {
      ...original.command,
      type: snapshot.tool ?? original.command.type,
      sourceVersionId: snapshot.sourceVersionId,
      operations: snapshot.operations,
      attachedInputs: snapshot.attachedInputs ?? original.command.attachedInputs,
      maskApplied: snapshot.maskApplied ?? original.command.maskApplied,
    };
    const caps = await provider.capabilities();
    if (!caps.currentVersionInput) throw new Error("IMAGE_EDIT_CURRENT_VERSION_UNSUPPORTED");
    this.assertCapabilities(command.operations, caps);
    const attempt: ImageEditAttempt = {
      id: randomUUID(), childTaskId: task.id, snapshotId: snapshot.id, attemptNo: attempts.length + 1,
      status: "generating", command, provider: editProviderSnapshot(provider), errorCode: null, errorMessage: null,
      createdAt: new Date().toISOString(), completedAt: null,
    };
    const childTask = { ...task, status: "generating" as const, errorCode: null, errorMessage: null, updatedAt: attempt.createdAt };
    const result = await this.appendAttempt({ idempotencyKey: input.idempotencyKey, snapshot, childTask, attempt });
    if (!result.duplicate) void this.execute(result.attempt, provider);
    return result;
  }
  private onVersionCompleted?: (childTask: ImageEditChildTask) => Promise<void>;
  setOnVersionCompleted(listener: (childTask: ImageEditChildTask) => Promise<void>) { this.onVersionCompleted = listener; }
  async clearFinalVersions(childTaskIds: string[]) { if (childTaskIds.length) await this.repository.clearFinalVersions?.(childTaskIds); }
  async selectVersion(childTaskId: string, versionId: string, selection: "current" | "final") { return this.repository.selectVersion(childTaskId, versionId, selection); }
  async getTask(childTaskId: string) { const task = await this.repository.getChildTask(childTaskId); if (!task) return null; return { task, snapshot: await this.repository.getSnapshot(task.snapshotId), attempts: await this.repository.listAttempts(task.id), versions: await this.repository.listVersions(task.id) }; }
  async listTasksBySourceCard(sourceCardId: string) { const tasks = await this.repository.listChildTasksBySourceCard(sourceCardId); return Promise.all(tasks.map(async (task) => ({ task, snapshot: await this.repository.getSnapshot(task.snapshotId), attempts: await this.repository.listAttempts(task.id), versions: await this.repository.listVersions(task.id) }))); }
  async listAllTasks() { const tasks = await this.repository.listChildTasks(); return Promise.all(tasks.map(async (task) => ({ task, snapshot: await this.repository.getSnapshot(task.snapshotId), attempts: await this.repository.listAttempts(task.id), versions: await this.repository.listVersions(task.id) }))); }
  private validateOperation(operation: EditOperation) {
    if (!operation.sourceVersionId || !operation.parentVersionId) throw new Error("EDIT_SOURCE_VERSION_REQUIRED");
    const region = operation.payload.region;
    if (region && typeof region === "object") this.validateRect(region as Record<string, unknown>);
    const prompt = typeof operation.payload.prompt === "string" ? operation.payload.prompt.trim() : "";
    if (["re_edit", "add_text", "redraw", "erase"].includes(operation.type) && !prompt) throw new Error(`${operation.type.toUpperCase()}_PROMPT_REQUIRED`);
    if (["redraw", "erase"].includes(operation.type)) {
      if (!Array.isArray(operation.payload.strokes) || !operation.payload.strokes.length) throw new Error("MASK_STROKES_REQUIRED");
      for (const stroke of operation.payload.strokes) {
        if (!stroke || typeof stroke !== "object" || !Array.isArray((stroke as Record<string, unknown>).points)) throw new Error("MASK_STROKES_INVALID");
        const mode = (stroke as Record<string, unknown>).mode; if (mode !== undefined && mode !== "draw" && mode !== "erase") throw new Error("MASK_STROKE_MODE_INVALID");
        const points = (stroke as Record<string, unknown>).points as unknown[];
        if (!points.length) throw new Error("MASK_POINTS_REQUIRED");
        const width = Number((stroke as Record<string, unknown>).width); if (!Number.isFinite(width) || width <= 0 || width > 1) throw new Error("MASK_BRUSH_WIDTH_INVALID");
        for (const point of (stroke as Record<string, unknown>).points as unknown[]) { if (!point || typeof point !== "object") throw new Error("MASK_POINT_INVALID"); const p = point as Record<string, unknown>; if (!this.inUnit(Number(p.x)) || !this.inUnit(Number(p.y))) throw new Error("MASK_POINT_INVALID"); }
      }
      const mask = operation.payload.mask; if (mask && typeof mask === "object") { const value = mask as Record<string, unknown>; if (value.mimeType !== "image/png" || !Number.isInteger(value.width) || !Number.isInteger(value.height)) throw new Error("MASK_METADATA_INVALID"); }
    }
    if (operation.type === "change_text") {
      const { originalText, newText } = operation.payload;
      if (typeof originalText !== "string" || !originalText.trim() || typeof newText !== "string" || !region || typeof region !== "object") {
        throw new Error("CHANGE_TEXT_FIELDS_REQUIRED");
      }
      if (originalText.length > CHANGE_TEXT_MAX_LENGTH) throw new Error("CHANGE_TEXT_ORIGINAL_TEXT_TOO_LONG");
      if (newText.length > CHANGE_TEXT_MAX_LENGTH) throw new Error("CHANGE_TEXT_NEW_TEXT_TOO_LONG");
    }
  }
  private async appendAttempt(input: { idempotencyKey: string; snapshot: EditSnapshot; childTask: ImageEditChildTask; attempt: ImageEditAttempt }) {
    if (this.repository.appendAttempt) return this.repository.appendAttempt(input);
    return this.repository.submit(input);
  }
  private assertCapabilities(operations: ReadonlyArray<EditOperation>, caps: ImageEditProviderCapabilities) {
    const capabilities = {
      re_edit: caps.imageToImage, restore_product: caps.imageToImage,
      add_text: caps.addText, change_text: caps.changeText, redraw: caps.redraw, erase: caps.erase, outpaint: caps.outpaint,
    };
    for (const operation of operations) {
      if (!capabilities[operation.type]) throw new Error(`IMAGE_EDIT_CAPABILITY_UNSUPPORTED:${operation.type}`);
    }
  }
  private validateRect(rect: Record<string, unknown>) { if (!["x", "y", "width", "height"].every((key) => Number.isFinite(Number(rect[key])))) throw new Error("NORMALIZED_RECT_INVALID"); if (!this.inUnit(Number(rect.x)) || !this.inUnit(Number(rect.y)) || !this.inUnit(Number(rect.width)) || !this.inUnit(Number(rect.height)) || Number(rect.width) <= 0 || Number(rect.height) <= 0 || Number(rect.x) + Number(rect.width) > 1 || Number(rect.y) + Number(rect.height) > 1) throw new Error("NORMALIZED_RECT_INVALID"); }
  private inUnit(value: number) { return Number.isFinite(value) && value >= 0 && value <= 1; }
  private async execute(attempt: ImageEditAttempt, provider: ImageEditProvider) { try { const source = await this.resolveSource(attempt.command.sourceVersionId); if (!source) throw new Error("SOURCE_VERSION_NOT_FOUND"); const generated = await provider.edit(attempt.command, source); const objectKey = `image-edits/${attempt.childTaskId}/versions/${randomUUID()}.png`; await this.storage.put({ key: objectKey, bytes: generated.bytes, contentType: generated.mimeType }); const sha256 = createHash("sha256").update(generated.bytes).digest("hex"); const childBeforeComplete = await this.repository.getChildTask(attempt.childTaskId); if (childBeforeComplete && this.onVersionCompleted) await this.onVersionCompleted(childBeforeComplete); await this.repository.completeAttempt({ attemptId: attempt.id, objectKey, sha256, width: generated.width, height: generated.height, mimeType: generated.mimeType, completedAt: new Date().toISOString() }); } catch (error) { await this.repository.failAttempt(attempt.id, error instanceof Error ? error.message : "IMAGE_EDIT_FAILED", error instanceof Error ? error.message : "IMAGE_EDIT_FAILED", new Date().toISOString()).catch(() => undefined); } }
}
