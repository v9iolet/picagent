import { useState } from "react";
import type { ApiImage } from "../../api/client";
import { IMAGE_UPLOAD_ACCEPT, useImageUpload } from "../../hooks/useImageUpload";
import { ProductImageGuideTip } from "../product-image-guide/ProductImageGuideTip";

const maxProductImages = 6;

interface Props {
  images: ApiImage[];
  busy: boolean;
  canUpload: boolean;
  upload: (files: File[]) => void;
  onUploadError: (message: string) => void;
  remove: (image: ApiImage) => void;
}

export function StudioProductImageUpload({ images, busy, canUpload, upload, onUploadError, remove }: Props) {
  const [drag, setDrag] = useState(false);
  const { prepareFiles } = useImageUpload({
    existingCount: images.length,
    maxCount: maxProductImages,
    countMessage: `每个批次最多上传 ${maxProductImages} 张商品原图。`,
  });
  function selectFiles(files: FileList | null) {
    if (busy || !canUpload || !files?.length) return;
    try {
      upload(prepareFiles(Array.from(files)));
    } catch (error) {
      onUploadError(error instanceof Error ? error.message : "图片上传失败");
    }
  }
  return (
    <section>
      <div className="pig-heading-row">
        <div className="pig-heading-left">
          <h2>商品原图</h2>
          <ProductImageGuideTip label="商品原图上传说明" />
        </div>
        <small>{images.length} / {maxProductImages}</small>
      </div>
      <div
        className={"ss-upload" + (drag ? " dragging" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          selectFiles(e.dataTransfer.files);
        }}
      >
        {images.map((im) => (
          <div className="ss-thumb" key={im.id}>
            <img alt={im.originalFilename} src={im.thumbnailPreviewUrl} />
            <button type="button" aria-label={"移除 " + im.originalFilename} onClick={() => remove(im)}>
              ×
            </button>
          </div>
        ))}
        {images.length < maxProductImages && canUpload && (
          <label className="ss-add">
            <b>＋</b>上传原图
            <input
              type="file"
              accept={IMAGE_UPLOAD_ACCEPT}
              aria-label="上传商品原图"
              multiple
              onChange={(e) => {
                selectFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      {!canUpload && (
        <small>当前为历史批次原图；可移除后按所选原图生成新批次。</small>
      )}
    </section>
  );
}
