import type { LibraryResource } from "./types.js";

export function isProductImageResource(resource: Pick<LibraryResource, "resourceType">) {
  return resource.resourceType === "base_image" || resource.resourceType === "input_image";
}

export function assertPublishedProductImageResource(resource: LibraryResource) {
  if (!isProductImageResource(resource)) throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
  if (resource.status !== "published") throw new Error("LIBRARY_RESOURCE_NOT_PUBLISHED");
}

export function assertReferenceAllowed(resource: LibraryResource, suiteId: string, targetType: "plan" | "task") {
  const crossSuite = resource.suiteId !== null && resource.suiteId !== suiteId;
  if (crossSuite && !isProductImageResource(resource)) throw new Error("LIBRARY_RESOURCE_FORBIDDEN");
  if ((crossSuite || resource.status !== undefined) && resource.status !== "published") throw new Error("LIBRARY_RESOURCE_NOT_PUBLISHED");
  if (resource.resourceType === "process_image") throw new Error("LIBRARY_PROCESS_IMAGE_NOT_SELECTABLE");
  if (resource.resourceType === "prompt_template" && resource.stage !== (targetType === "plan" ? "plan" : "task_image")) throw new Error("LIBRARY_STAGE_MISMATCH");
}
