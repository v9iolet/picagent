import { useState } from "react";
import type { ApiImage } from "../../api/client";
import { ProductImageGuideTip } from "../product-image-guide/ProductImageGuideTip";

interface Props {
  images: ApiImage[];
  busy: boolean;
  canUpload: boolean;
  upload: (files: File[]) => void;
  remove: (image: ApiImage) => void;
}

export function StudioProductImageUpload({ images, busy, canUpload, upload, remove }: Props) {
  const [drag, setDrag] = useState(false);
  return (
    <section>
      <div className="pig-heading-row">
        <div className="pig-heading-left">
          <h2>商品原图</h2>
          <ProductImageGuideTip label="商品原图上传说明" />
        </div>
        <small>{images.length} / 6</small>
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
          if (canUpload && !busy) upload(Array.from(e.dataTransfer.files));
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
        {images.length < 6 && canUpload && (
          <label className="ss-add">
            <b>＋</b>上传原图
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="上传商品原图"
              multiple
              onChange={(e) => {
                upload(Array.from(e.target.files ?? []));
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
