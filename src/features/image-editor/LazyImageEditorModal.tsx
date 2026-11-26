import { lazy, Suspense, type ComponentProps } from "react";

const ImageEditorModal = lazy(() => import("./ImageEditorModal").then(module => ({ default: module.ImageEditorModal })));

export function LazyImageEditorModal(props: ComponentProps<typeof ImageEditorModal>) {
  return (
    <Suspense fallback={<div className="suite-toast show" role="status">正在加载图片编辑器…</div>}>
      <ImageEditorModal {...props} />
    </Suspense>
  );
}
