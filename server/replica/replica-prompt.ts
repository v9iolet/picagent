import type { PromptTemplateRuntime } from "../prompt-library.js";
import type {
  LlmClient,
  PromptRepository,
  ReplicaCloneLevel,
  ReplicaPromptLlmInput,
  ReplicaPromptProductImage,
  ReplicaPromptReferenceImage,
} from "../types.js";

export const REPLICA_PROMPT_SCHEMA_VERSION = "replica-prompt-v1" as const;
export const REPLICA_TASK_NAME_MAX_LENGTH = 20;

export type ReplicaTemplateCode = "replica.compose" | "replica.high";

export interface ReplicaVisualStructure {
  composition?: string;
  lighting?: string;
  palette?: string;
  layout?: string;
  textBlocks?: string[];
  [key: string]: unknown;
}

export interface ReplicaCopyBlock {
  role?: string;
  text: string;
  position?: string;
}

export interface ReplicaPromptItem {
  referenceId: string;
  visualStructure: ReplicaVisualStructure;
  copy: ReplicaCopyBlock[];
  prompt: string;
}

export interface ReplicaPromptOutput {
  schemaVersion: typeof REPLICA_PROMPT_SCHEMA_VERSION;
  taskName: string;
  sharedStyle: string | null;
  items: ReplicaPromptItem[];
}

export class ReplicaPromptError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, details: string[] = []) {
    super(details.length > 0 ? `${code}: ${details.join("；")}` : code);
    this.name = "ReplicaPromptError";
    this.code = code;
    this.details = details;
  }
}

export interface BuildReplicaPromptInputParams {
  requestId?: string;
  template: Pick<PromptTemplateRuntime, "templateVersionId" | "body" | "userPromptTemplate">;
  cloneLevel: ReplicaCloneLevel;
  sceneType: string;
  language: string;
  styleUnified: boolean;
  unifiedRequirement?: string | null;
  productInfo?: string | null;
  references: ReplicaPromptReferenceImage[];
  productImages?: ReplicaPromptProductImage[];
}

export interface ValidateReplicaPromptOptions {
  expectedReferenceIds: string[];
  styleUnified: boolean;
  hasProductImages?: boolean;
}

export interface AnalyzeReplicaPromptsParams extends BuildReplicaPromptInputParams {
  llm: LlmClient;
}

export function replicaTemplateCodeForCloneLevel(cloneLevel: ReplicaCloneLevel): ReplicaTemplateCode {
  return cloneLevel === "compose" ? "replica.compose" : "replica.high";
}

export async function resolveReplicaPromptTemplate(
  prompts: PromptRepository,
  cloneLevel: ReplicaCloneLevel,
): Promise<PromptTemplateRuntime | null> {
  const published = await prompts.listPublished("replica_prompt");
  const expectedCode = replicaTemplateCodeForCloneLevel(cloneLevel);
  const matched =
    published.find((item) => item.applicability?.cloneLevel === cloneLevel) ??
    published.find((item) => item.code === expectedCode);
  if (!matched) return null;
  return prompts.getPublishedVersion(matched.templateVersionId, "replica_prompt");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncateChars(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : chars.slice(0, maxLength).join("");
}

export function buildReplicaPromptInput(params: BuildReplicaPromptInputParams): ReplicaPromptLlmInput {
  if (!Array.isArray(params.references) || params.references.length === 0) {
    throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", ["至少需要提供 1 张参考图"]);
  }
  const seenIds = new Set<string>();
  const references = [...params.references]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((ref) => {
      const referenceId = ref.referenceId.trim();
      if (!referenceId) throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", ["参考图 referenceId 不能为空"]);
      if (seenIds.has(referenceId)) throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", [`输入参考图 ID 重复：${referenceId}`]);
      seenIds.add(referenceId);
      const requirement = ref.requirement?.trim();
      return {
        referenceId,
        ordinal: ref.ordinal,
        ...(requirement ? { requirement } : {}),
        mimeType: ref.mimeType,
        bytes: ref.bytes,
      };
    });
  const productImages = [...(params.productImages ?? [])]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((img) => ({
      id: img.id,
      ordinal: img.ordinal,
      mimeType: img.mimeType,
      bytes: img.bytes,
    }));
  const unifiedRequirement = params.unifiedRequirement?.trim();
  const productInfo = params.productInfo?.trim();
  return {
    ...(params.requestId ? { requestId: params.requestId } : {}),
    template: {
      templateVersionId: params.template.templateVersionId,
      body: params.template.body,
      userPromptTemplate: params.template.userPromptTemplate,
    },
    cloneLevel: params.cloneLevel,
    sceneType: params.sceneType.trim(),
    language: params.language.trim(),
    styleUnified: Boolean(params.styleUnified),
    ...(unifiedRequirement ? { unifiedRequirement } : {}),
    ...(productInfo ? { productInfo } : {}),
    references,
    productImages,
  };
}

function normalizeVisualStringField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => normalizeVisualStringField(item))
      .filter((item): item is string => Boolean(item))
      .join("；");
    return joined || undefined;
  }
  return undefined;
}

function normalizeTextBlocks(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  const blocks: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) blocks.push(trimmed);
    } else if (isPlainObject(entry) && typeof entry.text === "string") {
      const trimmed = entry.text.trim();
      if (trimmed) blocks.push(trimmed);
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      blocks.push(String(entry));
    }
  }
  return blocks;
}

function normalizeVisualStructure(value: unknown, referenceId: string, errors: string[]): ReplicaVisualStructure {
  if (value === undefined || value === null) return {};
  if (isPlainObject(value)) {
    const result: ReplicaVisualStructure = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "composition" || key === "lighting" || key === "palette" || key === "layout") {
        const normalized = normalizeVisualStringField(entry);
        if (normalized !== undefined) result[key] = normalized;
      } else if (key === "textBlocks") {
        const normalized = normalizeTextBlocks(entry);
        if (normalized !== undefined) result.textBlocks = normalized;
      } else {
        result[key] = entry;
      }
    }
    return result;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { summary: trimmed } : {};
  }
  errors.push(`参考图 "${referenceId}" 的 visualStructure 格式无效`);
  return {};
}

function normalizeCopyBlocks(value: unknown, referenceId: string, errors: string[]): ReplicaCopyBlock[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [{ text: trimmed }] : [];
  }
  if (isPlainObject(value)) {
    const blocks: ReplicaCopyBlock[] = [];
    for (const [role, entry] of Object.entries(value)) {
      if (typeof entry !== "string") {
        errors.push(`参考图 "${referenceId}" 的 copy.${role} 必须是字符串`);
        continue;
      }
      const text = entry.trim();
      if (text) blocks.push({ role, text });
    }
    return blocks;
  }
  if (!Array.isArray(value)) {
    errors.push(`参考图 "${referenceId}" 的 copy 格式无效`);
    return [];
  }
  const blocks: ReplicaCopyBlock[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) blocks.push({ text });
      continue;
    }
    if (!isPlainObject(entry) || typeof entry.text !== "string") {
      errors.push(`参考图 "${referenceId}" 的 copy[${index}] 格式无效`);
      continue;
    }
    const text = entry.text.trim();
    if (!text) continue;
    const role = typeof entry.role === "string" && entry.role.trim() ? entry.role.trim() : undefined;
    const position = typeof entry.position === "string" && entry.position.trim() ? entry.position.trim() : undefined;
    blocks.push({ ...(role ? { role } : {}), text, ...(position ? { position } : {}) });
  }
  return blocks;
}

export function parseAndValidateReplicaPromptOutput(
  raw: unknown,
  options: ValidateReplicaPromptOptions,
): ReplicaPromptOutput {
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    const cleaned = candidate.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      candidate = JSON.parse(cleaned);
    } catch {
      throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", ["模型输出不是合法 JSON"]);
    }
  }
  if (!isPlainObject(candidate)) {
    throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", ["模型输出必须是 JSON 对象"]);
  }

  const errors: string[] = [];
  if (candidate.schemaVersion !== REPLICA_PROMPT_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 "${REPLICA_PROMPT_SCHEMA_VERSION}"，实际收到 ${JSON.stringify(candidate.schemaVersion)}`);
  }

  let taskName = "";
  if (options.hasProductImages === false) {
    taskName = "";
  } else if (candidate.taskName === undefined || candidate.taskName === null) {
    taskName = "";
  } else if (typeof candidate.taskName === "string") {
    taskName = truncateChars(candidate.taskName.trim(), REPLICA_TASK_NAME_MAX_LENGTH);
  } else {
    errors.push("taskName 必须是字符串或空值");
  }

  let sharedStyle: string | null = null;
  if (!options.styleUnified) {
    sharedStyle = null;
  } else if (candidate.sharedStyle === undefined || candidate.sharedStyle === null) {
    sharedStyle = null;
  } else if (typeof candidate.sharedStyle === "string") {
    sharedStyle = candidate.sharedStyle.trim() || null;
  } else {
    errors.push("sharedStyle 必须是字符串或 null");
  }

  if (!Array.isArray(candidate.items)) {
    errors.push("items 必须是数组");
    throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", errors);
  }

  const expectedIds = options.expectedReferenceIds;
  const expectedSet = new Set(expectedIds);
  const byReferenceId = new Map<string, ReplicaPromptItem>();

  for (const [index, entry] of candidate.items.entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`items[${index}] 必须是对象`);
      continue;
    }
    const referenceId = typeof entry.referenceId === "string" ? entry.referenceId.trim() : "";
    if (!referenceId) {
      errors.push(`items[${index}].referenceId 不能为空`);
      continue;
    }
    if (!expectedSet.has(referenceId)) {
      errors.push(`items[${index}].referenceId "${referenceId}" 不在输入参考图列表中`);
      continue;
    }
    if (byReferenceId.has(referenceId)) {
      errors.push(`referenceId "${referenceId}" 重复出现`);
      continue;
    }
    const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
    if (!prompt) {
      errors.push(`参考图 "${referenceId}" 的 prompt 不能为空`);
    }
    const visualStructure = normalizeVisualStructure(entry.visualStructure, referenceId, errors);
    const copy = normalizeCopyBlocks(entry.copy, referenceId, errors);
    byReferenceId.set(referenceId, {
      referenceId,
      visualStructure,
      copy,
      prompt,
    });
  }

  for (const expectedId of expectedIds) {
    if (!byReferenceId.has(expectedId)) {
      errors.push(`缺少参考图 "${expectedId}" 的输出项`);
    }
  }

  if (errors.length > 0) {
    throw new ReplicaPromptError("REPLICA_OUTPUT_INVALID", errors);
  }

  return {
    schemaVersion: REPLICA_PROMPT_SCHEMA_VERSION,
    taskName,
    sharedStyle,
    items: expectedIds.map((id) => byReferenceId.get(id)!),
  };
}

export async function analyzeReplicaPrompts(params: AnalyzeReplicaPromptsParams): Promise<{
  input: ReplicaPromptLlmInput;
  output: ReplicaPromptOutput;
  rawOutput: unknown;
}> {
  if (!params.llm.generateReplicaPrompts) {
    throw new ReplicaPromptError("REPLICA_LLM_NOT_SUPPORTED", ["当前多模态模型客户端不支持爆品图复刻分析"]);
  }
  const input = buildReplicaPromptInput(params);
  const rawOutput = await params.llm.generateReplicaPrompts(input);
  const output = parseAndValidateReplicaPromptOutput(rawOutput, {
    expectedReferenceIds: input.references.map((ref) => ref.referenceId),
    styleUnified: input.styleUnified,
    hasProductImages: input.productImages.length > 0,
  });
  return { input, output, rawOutput };
}
