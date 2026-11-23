export const pipelineErrorMessages: Readonly<Record<string, string>> = {
  PLAN_TEMPLATE_OUTDATED: "请先在模板库发布最新版结构计划模板，再生成套图。",
  STRUCTURE_PLAN_FAILED: "图片结构规划失败，请重试。",
  CATEGORY_PROMPT_FAILED: "类别提示词生成失败，请重试。",
  TASK_MATERIALIZATION_FAILED: "创建套图任务卡失败，请重试。",
  IMAGE_GENERATION_FAILED: "套图图片生成失败，请重试。",
  PIPELINE_INTERRUPTED: "生成服务中断，请继续流水线。",
  PIPELINE_TIMEOUT: "套图生成等待超时，请重试。",
  PIPELINE_FAILED: "一键生成套图失败，请重试。",
};
