import type { ApiLibraryResource } from "../../api/client";

export const resourceLabel = (resource: ApiLibraryResource) => ({
  input_image: "商品实拍原图",
  base_image: "白底底图",
  task_image_version: "AI 生成结果",
  process_image: "过程图",
  reverse_reference_asset: "爆品图反推",
  prompt_template: "提示词模板",
}[resource.resourceType]);

export const stageLabel = (stage: ApiLibraryResource["stage"]) => ({
  base_refine: "底图精修",
  plan: "计划生成",
  structure_plan: "结构规划",
  category_prompt: "类别提示词",
  task_image: "单卡创作",
  reverse_prompt: "爆品图反推",
  listing_copy: "上架文案",
  replica_prompt: "爆品图复刻",
} as Record<string, string>)[stage ?? ""] ?? "工作台资源";

export const sourceOriginLabel = (resource: ApiLibraryResource) => {
  const isEditorDerived = resource.source?.generatedBy === "image_editor";
  const isReplica =
    resource.source?.origin === "replica" ||
    resource.source?.originKind === "replica" ||
    resource.stage === "replica_prompt";
  if (isEditorDerived) {
    return isReplica ? "编辑生成 · 爆品图复刻" : "编辑生成";
  }
  if (isReplica) {
    return "爆品图复刻";
  }
  if (resource.source?.reversePlanId) {
    return "爆品图反推";
  }
  return null;
};

export const statusLabel = (status: ApiLibraryResource["status"]) =>
  ({ draft: "草稿", published: "已发布", archived: "已归档", retired: "已下架" }[status ?? "published"] ?? "已发布");

export const templateStatusLabel = (status: ApiLibraryResource["status"]) =>
  ({ draft: "草稿", published: "在用", archived: "已归档", retired: "已下架" }[status ?? "published"] ?? "在用");

export const statusClass = (status: ApiLibraryResource["status"]) =>
  status === "draft" ? "warn" : status === "archived" || status === "retired" ? "risk" : "pass";

export const templateUsedBy = (resource: ApiLibraryResource): string[] => {
  if (Array.isArray(resource.usedBy)) return resource.usedBy.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (Array.isArray(resource.source?.usedBy)) {
    return (resource.source.usedBy as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return [];
};

export const promptTextFor = (resource: ApiLibraryResource) => {
  if (resource.resourceType === "prompt_template") return String(resource.source?.body ?? "暂无提示词正文");
  const snapshot = resource.promptSnapshot;
  if (typeof snapshot?.finalPrompt === "string" && snapshot.finalPrompt.trim()) return snapshot.finalPrompt;
  if (typeof snapshot?.prompt === "string" && snapshot.prompt.trim()) return snapshot.prompt;
  return "暂无可读提示词内容";
};

export const promptSnapshotValue = (resource: ApiLibraryResource, key: string) => {
  const value = resource.promptSnapshot?.[key];
  if (typeof value === "string" || typeof value === "number") return String(value);
  const params = resource.promptSnapshot?.generationParams;
  if (params && typeof params === "object" && key in params) {
    const nested = (params as Record<string, unknown>)[key];
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }
  return "未记录";
};

export const dimensionsFor = (resource: ApiLibraryResource) => {
  const match = resource.summary.match(/(\d+)\s*[×x]\s*(\d+)/);
  return match ? `${match[1]} × ${match[2]}` : "未记录";
};

export const ratioFor = (resource: ApiLibraryResource) => {
  const recorded = promptSnapshotValue(resource, "ratio");
  if (recorded !== "未记录") return recorded;
  const match = resource.summary.match(/(\d+)\s*[×x]\s*(\d+)/);
  if (!match) return "未记录";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = (a: number, b: number): number => (b === 0 ? 1 : a % b === 0 ? b : divisor(b, a % b));
  const gcd = divisor(width, height);
  return `${width / gcd}:${height / gcd}`;
};
