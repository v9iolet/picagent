import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";
import sharp from "sharp";
import { loadServerConfig } from "./config.js";
import { processGeneratedImage, processImage } from "./image.js";
import { ImageEditorService, type ImageEditorRepository } from "./image-editor.js";
import { runMigrations } from "./migrations.js";
import { PostgresImageEditorRepository } from "./repositories/postgres-image-editor-repository.js";
import { PostgresPlanRepository } from "./repositories/postgres-plan-repository.js";
import { PostgresReverseRepository } from "./repositories/postgres-reverse-repository.js";
import { PostgresSuiteRepository } from "./repositories/postgres-suite-repository.js";
import { PostgresTaskRepository } from "./repositories/postgres-task-repository.js";
import { MinioStorage } from "./storage/minio-storage.js";
import type { InputImage, PlanRepository, PlanSnapshot, ReverseRepository, StorageAdapter, SuiteRepository, TaskRepository } from "./types.js";

export interface DemoSeedDeps {
  repository: SuiteRepository;
  planRepository: PlanRepository;
  taskRepository: TaskRepository;
  reverseRepository: ReverseRepository;
  imageEditorRepository: ImageEditorRepository;
  storage: StorageAdapter;
  assetsDir?: string;
}

export interface DemoSeedResult {
  suiteId: string;
  suiteName: string;
  taskCount: number;
  editChildTaskId: string;
  reversePlanId: string;
  alreadySeeded: boolean;
}

const DEMO_SUITE_NAME = "65W 氮化镓快充 · Amazon 美国站演示套图";
const DEMO_SUITE_KEY = "demo-showcase-suite-v1";
const DEMO_REVERSE_KEY = "demo-showcase-reverse-v1";

async function readAssetOrPlaceholder(filePath: string, color: { r: number; g: number; b: number }): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return sharp({ create: { width: 640, height: 640, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
  }
}

export async function seedDemoShowcase(deps: DemoSeedDeps): Promise<DemoSeedResult> {
  const assetsDir = deps.assetsDir ?? path.resolve("public/assets");
  const now = new Date().toISOString();
  // Use repository-level idempotency key rather than listSuites() (which is capped at LIMIT 30)
  const suite = await deps.repository.createSuite(DEMO_SUITE_NAME, DEMO_SUITE_KEY);
  const existingTasks = await deps.taskRepository.listTasks(suite.id);
  if (existingTasks.length > 0) {
    const existingEdits = await deps.imageEditorRepository.listChildTasks();
    const matchedEdit = existingEdits.find((child) => existingTasks.some((t) => t.id === child.sourceCardId));
    const existingReverse = (await deps.reverseRepository.createPlan(DEMO_REVERSE_KEY)).plan;
    return {
      suiteId: suite.id,
      suiteName: suite.name,
      taskCount: existingTasks.filter((t) => t.status !== "archived").length,
      editChildTaskId: matchedEdit?.id ?? "",
      reversePlanId: existingReverse.id,
      alreadySeeded: true,
    };
  }

  const productMainBytes = await readAssetOrPlaceholder(path.join(assetsDir, "gan65-product.jpg"), { r: 245, g: 247, b: 250 });
  const productTightBytes = await readAssetOrPlaceholder(path.join(assetsDir, "gan65-product-tight.jpg"), { r: 235, g: 240, b: 248 });
  const sceneDeskBytes = await readAssetOrPlaceholder(path.join(assetsDir, "tokyo-desk-v3.jpg"), { r: 42, g: 64, b: 102 });

  // 1. Upload 2 source images & generate clean base versions
  const sourceInputs = [
    { filename: "gan65-product.jpg", bytes: productMainBytes, ordinal: 1 },
    { filename: "gan65-product-tight.jpg", bytes: productTightBytes, ordinal: 2 },
  ];

  const uploadedImages: Array<{ image: InputImage; baseVersionId: string; baseObjectKey: string }> = [];
  for (const item of sourceInputs) {
    const processed = await processImage(item.bytes, "image/jpeg");
    const inputId = randomUUID();
    const originalKey = `suites/${suite.id}/inputs/${inputId}/original`;
    const thumbKey = `suites/${suite.id}/inputs/${inputId}/thumbnail`;
    await deps.storage.put({ key: originalKey, bytes: item.bytes, contentType: processed.mimeType });
    await deps.storage.put({ key: thumbKey, bytes: processed.thumbnail, contentType: "image/jpeg" });
    const created = await deps.repository.createInputImage({
      id: inputId,
      suiteId: suite.id,
      ordinal: item.ordinal,
      originalObjectKey: originalKey,
      thumbnailObjectKey: thumbKey,
      sha256: processed.sha256,
      width: processed.width,
      height: processed.height,
      mimeType: processed.mimeType,
      originalFilename: item.filename,
      currentBaseVersionId: null,
      createdAt: now,
    }, `${DEMO_SUITE_KEY}:input:${item.ordinal}`);

    const baseProcessed = await processGeneratedImage(item.bytes);
    const baseVersionId = randomUUID();
    const baseObjectKey = `suites/${suite.id}/inputs/${created.id}/base/${baseVersionId}.png`;
    await deps.storage.put({ key: baseObjectKey, bytes: baseProcessed.bytes, contentType: baseProcessed.mimeType });
    const reservation = await deps.repository.beginBaseGeneration({
      id: randomUUID(),
      suiteId: suite.id,
      inputImageId: created.id,
      baseVersionId,
      idempotencyKey: `${DEMO_SUITE_KEY}:base:${item.ordinal}`,
      model: "gpt-image-2",
      endpoint: "/v1/images/edits",
      prompt: "纯白棚拍底图精修，保持 65W 氮化镓充电器外观结构与接口真实一致。",
      size: "1K",
      promptTemplateVersionId: "demo-base-v1",
      dynamicInput: { source_image_ids: created.id },
      quality: "medium",
      n: 1,
      responseFormat: "b64_json",
      createdAt: now,
    });
    await deps.repository.completeBaseGeneration({
      attemptId: reservation.attempt.id,
      objectKey: baseObjectKey,
      sha256: baseProcessed.sha256,
      width: baseProcessed.width,
      height: baseProcessed.height,
      mimeType: baseProcessed.mimeType,
      completedAt: now,
    });
    const refreshedImage = (await deps.repository.getInputImage(suite.id, created.id)) ?? { ...created, currentBaseVersionId: baseVersionId };
    uploadedImages.push({ image: refreshedImage, baseVersionId, baseObjectKey });
  }

  // 2. Save confirmed structure plan snapshot
  const planStyle = "极简现代跨境科技感棚拍风，主光柔和通透，搭配细微冷色调桌面反射，严格保持产品实拍外观与接口排布。";
  const snapshotId = randomUUID();
  const planItems: PlanSnapshot["items"] = [
    {
      id: randomUUID(),
      ordinal: 1,
      imageType: "main",
      title: "核心白底主图",
      purpose: "Amazon 首屏合规主图，居中展示 65W GaN 本体与折叠插脚",
      prompt: `系统安全约束：不得生成违法、危险或误导性内容。\n平台约束：Amazon 主图纯白背景，主体占比 85%，无促销贴纸。\n商品事实约束：65W GaN 三口快充（2C1A），折叠美规插脚。\n全局风格卡：${planStyle}\n当前类别提示词：正面 3/4 视角高清棚拍主图，突出哑光亲肤壳体与金属接口质感。`,
      referenceImageIds: [uploadedImages[0].image.id],
      globalStyleCard: { promptPrefix: planStyle },
      aspectRatio: "1:1",
      suggestedParams: { ratio: "1:1", size: "1K", quality: "high" },
    },
    {
      id: randomUUID(),
      ordinal: 2,
      imageType: "main",
      title: "东京极简桌面场景主图",
      purpose: "第二张场景主图，呈现笔记本与手机同时快充的真实办公桌面",
      prompt: `系统安全约束：不得生成违法、危险或误导性内容。\n平台约束：跨境生活化场景，光线真实自然。\n商品事实约束：支持 65W 笔记本供电，体积小巧便携。\n全局风格卡：${planStyle}\n当前类别提示词：极简东京书桌办公场景，充电器连接轻薄笔记本与智能手机，背景柔和景深。`,
      referenceImageIds: [uploadedImages[0].image.id],
      globalStyleCard: { promptPrefix: planStyle },
      aspectRatio: "1:1",
      suggestedParams: { ratio: "1:1", size: "1K", quality: "high" },
    },
    {
      id: randomUUID(),
      ordinal: 3,
      imageType: "detail",
      title: "三口快充卖点信息屏",
      purpose: "详情页核心卖点图，清晰表达 2×USB-C + 1×USB-A 功率分配",
      prompt: `系统安全约束：不得生成违法、危险或误导性内容。\n平台约束：英文留白排版区清晰易读。\n商品事实约束：65W Max，双 C 口 + 单 A 口，兼容主流笔记本与手机。\n全局风格卡：${planStyle}\n当前类别提示词：产品斜侧特写配合右侧信息留白，视觉聚焦三个快充接口与简洁标注线。`,
      referenceImageIds: [uploadedImages[0].image.id],
      globalStyleCard: { promptPrefix: planStyle },
      aspectRatio: "3:4",
      suggestedParams: { ratio: "3:4", size: "1K", quality: "high" },
    },
    {
      id: randomUUID(),
      ordinal: 4,
      imageType: "detail",
      title: "折叠插脚与质感特写",
      purpose: "详情页细节特写图，突出精密工艺与差旅便携优势",
      prompt: `系统安全约束：不得生成违法、危险或误导性内容。\n平台约束：微距细节清晰，不得虚构认证标志。\n商品事实约束：90 度折叠插脚，紧凑机身。\n全局风格卡：${planStyle}\n当前类别提示词：微距斜拍折叠插脚与外壳圆角过渡，柔和侧逆光凸显精致磨砂纹理。`,
      referenceImageIds: [uploadedImages[1].image.id],
      globalStyleCard: { promptPrefix: planStyle },
      aspectRatio: "3:4",
      suggestedParams: { ratio: "3:4", size: "1K", quality: "high" },
    },
  ];

  const snapshot: PlanSnapshot = {
    id: snapshotId,
    suiteId: suite.id,
    revisionNumber: 1,
    revisionKind: "human",
    parentSnapshotId: null,
    templateVersionId: "demo-structure-v1",
    dynamicInput: { platform: "amazon", output_language: "英文", product_name: "65W GaN 3-Port Charger" },
    humanInput: {},
    chunks: [{
      sourceChunkId: "demo.gan65-spec",
      sourceVersion: "1",
      title: "65W 氮化镓充电器规格事实卡",
      content: "总功率 65W Max；接口 2×USB-C + 1×USB-A；折叠美规插脚；哑光防火 PC 外壳。",
      fieldValues: { power: "65W", ports: "2C1A", plug: "US Foldable" },
      sourceKind: "validation_seed",
      sourceAssetPaths: ["public/assets/gan65-product.jpg"],
      contentSha256: createHash("sha256").update("demo.gan65-spec").digest("hex"),
    }],
    inputImageIds: uploadedImages.map((u) => u.image.id),
    baseVersionIds: uploadedImages.map((u) => u.baseVersionId),
    provider: { name: "demo-seed", model: "qwen-vl-max", isFake: true },
    requestSummary: { phase: "structure_plan" },
    rawOutputSummary: { seeded: true },
    schemaVersion: "suite-structure-plan-v2",
    phase: "structure_plan",
    confirmationStatus: "confirmed",
    confirmedAt: now,
    structure: {
      status: "READY_FOR_REVIEW",
      mainAllocation: { category: "main", count: 2, reason: "1 张合规纯白主图 + 1 张高转化桌面场景主图", sourceImageIds: [uploadedImages[0].image.id], factRefs: ["demo.gan65-spec"], missingFacts: [] },
      detailImageCount: 2,
      categoryAllocations: [
        { category: "feature_benefit", requirement: "required", count: 1, reason: "清晰传达 65W 三口快充核心卖点", sourceImageIds: [uploadedImages[0].image.id], factRefs: ["demo.gan65-spec"], missingFacts: [] },
        { category: "material_detail", requirement: "required", count: 1, reason: "展示折叠插脚与外壳做工细节", sourceImageIds: [uploadedImages[1].image.id], factRefs: ["demo.gan65-spec"], missingFacts: [] },
      ],
      globalStyleCard: { promptPrefix: planStyle },
    },
    items: planItems,
    createdAt: now,
  };
  await deps.planRepository.appendRevision(snapshot);

  // 3. Create 4 tasks and populate generated versions
  const createdTasks = await deps.taskRepository.createTasksFromSnapshot(
    suite.id,
    snapshot,
    uploadedImages.map((u) => u.image),
  );

  const sampleBuffers = [productMainBytes, sceneDeskBytes, sceneDeskBytes, productTightBytes];
  const taskVersionsByTaskId = new Map<string, { versionId: string; objectKey: string; width: number; height: number; bytes: Buffer; prompt: string }>();

  for (let index = 0; index < createdTasks.tasks.length; index += 1) {
    const task = createdTasks.tasks[index];
    const sample = sampleBuffers[index];
    const processed = await processGeneratedImage(sample);
    const batchId = randomUUID();
    const slotId = randomUUID();
    const attemptId = randomUUID();
    const versionKey = `suites/${suite.id}/tasks/${task.id}/versions/${randomUUID()}/final.png`;
    await deps.storage.put({ key: versionKey, bytes: processed.bytes, contentType: processed.mimeType });

    await deps.taskRepository.beginBatch({
      batch: { id: batchId, suiteId: suite.id, kind: "single", requestedCount: 1, taskIds: [task.id], status: "running", idempotencyKey: `${DEMO_SUITE_KEY}:gen:${index}`, createdAt: now, startedAt: now, finishedAt: null },
      slots: [{ id: slotId, batchId, taskId: task.id, slotOrdinal: 1, retryOfSlotId: null, status: "generating", selectedVersionId: null, createdAt: now, completedAt: null }],
      attempts: [{
        id: attemptId,
        slotId,
        attemptNo: 1,
        provider: "openai-compatible-image",
        model: "gpt-image-2",
        endpoint: "/v1/images/edits",
        requestSummary: { n: 1, size: "1K", quality: "high" },
        promptSnapshot: { prompt: task.promptDraft, finalPrompt: task.promptDraft, globalStyleCard: { promptPrefix: planStyle }, generationParams: task.generationParams },
        promptSha256: createHash("sha256").update(task.promptDraft).digest("hex"),
        contextSnapshot: { model: "gpt-image-2", channel: { channelId: "demo-ch", channelName: "Demo Studio Gateway", baseUrl: "https://demo.local/v1" }, suiteTaskId: task.id, imageType: task.imageType },
        sourceKind: "base",
        sourceObjectKey: uploadedImages[0].baseObjectKey,
        sourceInputImageId: uploadedImages[0].image.id,
        sourceBaseVersionId: uploadedImages[0].baseVersionId,
        status: "running",
        errorCode: null,
        errorMessage: null,
        externalRequestId: null,
        startedAt: now,
        finishedAt: null,
      }],
    });
    const completed = await deps.taskRepository.completeAttempt({
      attemptId,
      slotId,
      taskId: task.id,
      objectKey: versionKey,
      processObjectKeys: [],
      sha256: processed.sha256,
      width: processed.width,
      height: processed.height,
      mimeType: processed.mimeType,
      completedAt: now,
    });
    if (index === 0) {
      // Seed a second version on main task #1 so the demo showcases multi-version history
      const v2Processed = await processGeneratedImage(productTightBytes);
      const v2BatchId = randomUUID();
      const v2SlotId = randomUUID();
      const v2AttemptId = randomUUID();
      const v2Key = `suites/${suite.id}/tasks/${task.id}/versions/${randomUUID()}/final.png`;
      await deps.storage.put({ key: v2Key, bytes: v2Processed.bytes, contentType: v2Processed.mimeType });
      await deps.taskRepository.beginBatch({
        batch: { id: v2BatchId, suiteId: suite.id, kind: "single", requestedCount: 1, taskIds: [task.id], status: "running", idempotencyKey: `${DEMO_SUITE_KEY}:gen:0:v2`, createdAt: now, startedAt: now, finishedAt: null },
        slots: [{ id: v2SlotId, batchId: v2BatchId, taskId: task.id, slotOrdinal: 1, retryOfSlotId: null, status: "generating", selectedVersionId: null, createdAt: now, completedAt: null }],
        attempts: [{
          id: v2AttemptId,
          slotId: v2SlotId,
          attemptNo: 1,
          provider: "openai-compatible-image",
          model: "gpt-image-2",
          endpoint: "/v1/images/edits",
          requestSummary: { n: 1, size: "1K", quality: "high" },
          promptSnapshot: { prompt: task.promptDraft, finalPrompt: task.promptDraft, templateVersionId: snapshot.templateVersionId, globalStyleCard: { promptPrefix: planStyle }, generationParams: task.generationParams },
          promptSha256: createHash("sha256").update(task.promptDraft).digest("hex"),
          contextSnapshot: { model: "gpt-image-2", templateVersionId: snapshot.templateVersionId, channel: { channelId: "demo-ch", channelName: "Demo Studio Gateway", baseUrl: "https://demo.local/v1" }, suiteTaskId: task.id, imageType: task.imageType },
          sourceKind: "base",
          sourceObjectKey: uploadedImages[0].baseObjectKey,
          sourceInputImageId: uploadedImages[0].image.id,
          sourceBaseVersionId: uploadedImages[0].baseVersionId,
          status: "running",
          errorCode: null,
          errorMessage: null,
          externalRequestId: null,
          startedAt: now,
          finishedAt: null,
        }],
      });
      const v2Completed = await deps.taskRepository.completeAttempt({
        attemptId: v2AttemptId,
        slotId: v2SlotId,
        taskId: task.id,
        objectKey: v2Key,
        processObjectKeys: [],
        sha256: v2Processed.sha256,
        width: v2Processed.width,
        height: v2Processed.height,
        mimeType: v2Processed.mimeType,
        completedAt: now,
      });
      taskVersionsByTaskId.set(task.id, {
        versionId: v2Completed.version.id,
        objectKey: v2Key,
        width: v2Processed.width,
        height: v2Processed.height,
        bytes: v2Processed.bytes,
        prompt: task.promptDraft,
      });
    }
    if (index === 1) {
      await deps.taskRepository.selectVersion(task.id, completed.version.id, "final");
    }
    if (!taskVersionsByTaskId.has(task.id)) {
      taskVersionsByTaskId.set(task.id, {
        versionId: completed.version.id,
        objectKey: versionKey,
        width: processed.width,
        height: processed.height,
        bytes: processed.bytes,
        prompt: task.promptDraft,
      });
    }
  }

  // 4. Create 1 derived image-edit child card under main task #1 (with Before/After compare & marked final)
  const mainTask1 = createdTasks.tasks[0];
  const mainVersion1 = taskVersionsByTaskId.get(mainTask1.id)!;
  const editedBytes = await sharp(sceneDeskBytes).resize(mainVersion1.width, mainVersion1.height, { fit: "cover" }).png().toBuffer();

  const editorService = new ImageEditorService(
    deps.imageEditorRepository,
    {
      name: "demo-image-editor",
      version: "gpt-image-2",
      channel: { channelId: "demo-ch", channelName: "Demo Studio Gateway", baseUrl: "https://demo.local/v1" },
      capabilitiesVersion: "v1",
      capabilities: () => ({ imageToImage: true, addText: true, changeText: true, redraw: true, erase: true, outpaint: true, currentVersionInput: true }),
      edit: async () => ({ bytes: editedBytes, mimeType: "image/png", width: mainVersion1.width, height: mainVersion1.height }),
    },
    deps.storage,
    async () => ({ bytes: mainVersion1.bytes, mimeType: "image/png", width: mainVersion1.width, height: mainVersion1.height, generationPrompt: mainVersion1.prompt }),
  );

  await editorService.upsertOperation({
    sessionId: mainTask1.id,
    summary: "添加英文主标 65W GaN Fast Charge",
    operation: {
      operationId: "demo-op-add-text-1",
      type: "add_text",
      order: 1,
      sourceCardId: mainTask1.id,
      sourceVersionId: mainVersion1.versionId,
      parentVersionId: mainVersion1.versionId,
      summary: "添加文本：65W GaN Fast Charge",
      payload: {
        text: "65W GaN Fast Charge",
        region: { x: 0.08, y: 0.08, width: 0.56, height: 0.12, rotation: 0 },
        prompt: "现代无衬线科技感字体，与棚拍柔和光影自然融合，不遮挡产品主体",
      },
    },
  });
  const editSubmit = await editorService.submit({
    sessionId: mainTask1.id,
    idempotencyKey: `${DEMO_SUITE_KEY}:edit:1`,
    sourceCardId: mainTask1.id,
    sourceVersionId: mainVersion1.versionId,
    parentVersionId: mainVersion1.versionId,
    summary: "添加英文主标 65W GaN Fast Charge",
  });
  for (let i = 0; i < 20; i += 1) {
    const versions = await deps.imageEditorRepository.listVersions(editSubmit.childTask.id);
    if (versions.length > 0) {
      await editorService.selectVersion(editSubmit.childTask.id, versions[0].id, "final");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  // 5. Create 1 reverse-prompt demo plan
  const createdReverse = await deps.reverseRepository.createPlan(DEMO_REVERSE_KEY);
  const reversePlan = createdReverse.plan;
  const refProcessed = await processImage(sceneDeskBytes, "image/jpeg");
  const refId = randomUUID();
  const attemptId = randomUUID();
  const promptVersionId = randomUUID();
  const refOrigKey = `reverse/${reversePlan.id}/references/${refId}/original`;
  const refThumbKey = `reverse/${reversePlan.id}/references/${refId}/thumbnail`;
  await deps.storage.put({ key: refOrigKey, bytes: sceneDeskBytes, contentType: refProcessed.mimeType });
  await deps.storage.put({ key: refThumbKey, bytes: refProcessed.thumbnail, contentType: "image/jpeg" });
  await deps.reverseRepository.savePlan({
    ...reversePlan,
    mode: "main",
    status: "draft",
    updatedAt: now,
    references: [{
      id: refId,
      planId: reversePlan.id,
      ordinal: 1,
      filename: "tokyo-desk-v3.jpg",
      objectKey: refOrigKey,
      thumbnailObjectKey: refThumbKey,
      mimeType: refProcessed.mimeType,
      width: refProcessed.width,
      height: refProcessed.height,
      sha256: refProcessed.sha256,
      templateVersionId: "demo-reverse-main-v1",
      effectivePromptVersionId: promptVersionId,
      attempts: [{
        id: attemptId,
        referenceId: refId,
        status: "succeeded",
        retryOfAttemptId: null,
        templateVersionId: "demo-reverse-main-v1",
        mode: "main",
        baselineReferenceId: null,
        requestSummary: { seeded: true },
        rawOutput: { seeded: true },
        errorCode: null,
        errorMessage: null,
        promptVersionId,
        createdAt: now,
        completedAt: now,
      }],
      promptVersions: [{
        id: promptVersionId,
        referenceId: refId,
        kind: "model",
        prompt: "【构图与机位】45 度俯拍桌面场景，前景居中留出产品主体位，背景虚化展示轻薄笔记本与极简绿植。\n【光影与色彩】自然窗光从左侧 30 度切入，整体低饱和冷灰与原木暖色形成高级商业对比。\n【外观隔离声明】后续产品外观以绑定白底图为唯一真值，不迁移参考图中的任何品牌标识或参数文字。",
        rawOutput: { seeded: true },
        templateVersionId: "demo-reverse-main-v1",
        mode: "main",
        provider: { name: "demo-seed", model: "qwen-vl-max", isFake: true },
        createdAt: now,
      }],
      createdAt: now,
    }],
  });

  return {
    suiteId: suite.id,
    suiteName: suite.name,
    taskCount: createdTasks.tasks.length,
    editChildTaskId: editSubmit.childTask.id,
    reversePlanId: reversePlan.id,
    alreadySeeded: false,
  };
}

async function runCli() {
  const config = loadServerConfig();
  const pool = new Pool({ ...config.postgres, max: 4 });
  try {
    await runMigrations(pool);
    const minioClient = new MinioClient({
      endPoint: config.minio.endPoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
      region: config.minio.region,
    });
    const storage = new MinioStorage(minioClient, config.minio.bucket, undefined, config.minio.legacyBucket);
    const result = await seedDemoShowcase({
      repository: new PostgresSuiteRepository(pool),
      planRepository: new PostgresPlanRepository(pool),
      taskRepository: new PostgresTaskRepository(pool),
      reverseRepository: new PostgresReverseRepository(pool),
      imageEditorRepository: new PostgresImageEditorRepository(pool),
      storage,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
