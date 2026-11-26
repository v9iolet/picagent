import { imageEditProductInputs, type ImageSource, type MemoryImageEditorRepository } from "../server/image-editor.js";
import type { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import type { MemoryTaskRepository } from "../server/repositories/memory-task-repository.js";
import type { MemoryStorage } from "../server/storage/memory-storage.js";

export function makeAplusEditorSourceResolver(
  suites: MemorySuiteRepository,
  tasks: MemoryTaskRepository,
  editorTasks: MemoryImageEditorRepository,
  storage: MemoryStorage,
) {
  return async function resolveSource(versionId: string): Promise<ImageSource | null> {
    for (const child of await editorTasks.listChildTasks()) {
      const version = (await editorTasks.listVersions(child.id)).find(({ id }) => id === versionId);
      if (!version) continue;
      const attempt = await editorTasks.getAttempt(version.attemptId);
      if (!attempt) return null;
      const source = await resolveSource(attempt.command.sourceVersionId);
      const object = await storage.get(version.objectKey);
      if (!source || !object) return null;
      return {
        ...source, bytes: object.bytes, mimeType: object.contentType, width: version.width, height: version.height,
        generationPrompt: attempt.command.prompt,
      };
    }
    for (const suite of await suites.listSuites()) {
      for (const task of await tasks.listTasks(suite.id)) {
        if (task.originKind !== "aplus" || !task.sizePreset) continue;
        const { versions } = await tasks.listTaskVersions(task.id);
        const version = versions.find(({ id }) => id === versionId);
        if (!version) continue;
        const object = await storage.get(version.objectKey);
        if (!object) return null;
        return {
          bytes: object.bytes, mimeType: object.contentType, width: version.width, height: version.height,
          productInputs: imageEditProductInputs(version.contextSnapshot.inputImages),
          aplus: { preset: task.sizePreset, resolution: task.generationParams.size === "2K" ? "2K" : "1K" },
        };
      }
    }
    return null;
  };
}
