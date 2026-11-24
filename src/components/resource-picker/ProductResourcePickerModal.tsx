import { useEffect, useState } from "react";
import {
  ApiHttpError,
  suiteApi,
  type ApiLibraryResource,
  type ApiProductMaterialRef,
} from "../../api/client";
import { Icon } from "../../pages/shared";
import "./resource-picker.css";

export interface ProductResourceSelection extends ApiProductMaterialRef {
  resourceType?: "base_image";
  mimeType?: string | null;
}

export interface ProductResourcePickerModalProps {
  open: boolean;
  onClose: () => void;
  max?: number;
  initialSelected?: ProductResourceSelection[];
  onConfirm: (selected: ProductResourceSelection[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  confirmLabel?: string;
  allowEmpty?: boolean;
}

function isAvailableProductResource(resource: ApiLibraryResource): boolean {
  return resource.status === "published" && resource.resourceType === "base_image";
}

export function ProductResourcePickerModal({
  open,
  onClose,
  max = 3,
  initialSelected = [],
  onConfirm,
  onError,
  title = "选择白底底图",
  eyebrow = "PRODUCT MATERIALS",
  subtitle,
  confirmLabel = "确认绑定",
  allowEmpty = false,
}: ProductResourcePickerModalProps) {
  const [items, setItems] = useState<ApiLibraryResource[] | null>(null);
  const [selected, setSelected] = useState<ProductResourceSelection[]>([]);
  const [removedNotice, setRemovedNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const limit = Math.max(0, Math.floor(max));

  useEffect(() => {
    if (!open) return;
    const normalizedInitial = initialSelected
      .slice()
      .sort((a, b) => a.order - b.order)
      .slice(0, limit)
      .map((item, idx) => ({ ...item, order: idx + 1 }));
    setSelected(normalizedInitial);
    setRemovedNotice("");
    setItems(null);
    setLoadError(false);

    let active = true;
    void (async () => {
      try {
        const result = await suiteApi.listLibraryResources({
          resourceType: "base_image",
          status: "published",
          pageSize: 100,
        });
        if (!active) return;
        const loadedItems = result.items.filter(isAvailableProductResource);
        const loadedIds = new Set(loadedItems.map((item) => item.id));
        const missingFromPage = normalizedInitial.filter((ref) => !loadedIds.has(ref.resourceId));
        const unavailableIds = new Set<string>();
        let deletedCount = 0;
        let unsupportedCount = 0;

        if (missingFromPage.length > 0) {
          await Promise.all(
            missingFromPage.map(async (ref) => {
              try {
                const detail = await suiteApi.getLibraryResource(ref.resourceId);
                if (!isAvailableProductResource(detail)) {
                  unavailableIds.add(ref.resourceId);
                  unsupportedCount += 1;
                }
              } catch (error) {
                if (error instanceof ApiHttpError && error.status === 404) {
                  unavailableIds.add(ref.resourceId);
                  deletedCount += 1;
                }
              }
            }),
          );
        }
        if (!active) return;

        setItems(loadedItems);
        if (unavailableIds.size > 0) {
          setSelected((current) =>
            current
              .filter((ref) => !unavailableIds.has(ref.resourceId))
              .map((ref, idx) => ({ ...ref, order: idx + 1 })),
          );
          if (deletedCount > 0 && unsupportedCount === 0) {
            setRemovedNotice(`已移除 ${deletedCount} 张已删除的图片`);
          } else if (unsupportedCount > 0 && deletedCount === 0) {
            setRemovedNotice(`已移除 ${unsupportedCount} 张历史原图引用（请改选白底底图）`);
          } else {
            setRemovedNotice(`已移除 ${unavailableIds.size} 张不可选的图片`);
          }
        }
      } catch {
        if (active) setLoadError(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, limit]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, loading, onClose]);

  if (!open) return null;

  const toggle = (item: ApiLibraryResource) => {
    setSelected((current) => {
      const exists = current.some((ref) => ref.resourceId === item.id);
      if (exists) {
        return current
          .filter((ref) => ref.resourceId !== item.id)
          .map((ref, idx) => ({ ...ref, order: idx + 1 }));
      }
      if (current.length >= limit) return current;
      return [
        ...current,
        {
          libraryReferenceId: "",
          resourceId: item.id,
          resourceVersionId: item.resourceVersionId,
          order: current.length + 1,
          title: item.title,
          previewUrl: item.previewUrl ?? `/api/library/resources/${encodeURIComponent(item.id)}/preview`,
          resourceType: "base_image",
          mimeType: item.mimeType,
        },
      ];
    });
  };

  const removeSelected = (resourceId: string) => {
    setSelected((current) =>
      current
        .filter((ref) => ref.resourceId !== resourceId)
        .map((ref, idx) => ({ ...ref, order: idx + 1 })),
    );
  };

  const move = (index: number, delta: number) => {
    setSelected((current) => {
      const next = current.slice();
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((item, order) => ({ ...item, order: order + 1 }));
    });
  };

  const confirm = async () => {
    if ((!allowEmpty && !selected.length) || loading) return;
    setLoading(true);
    try {
      await onConfirm(selected);
      onClose();
    } catch (error) {
      onError?.(error);
    } finally {
      setLoading(false);
    }
  };

  const resolvedSubtitle = subtitle ?? `最多 ${limit} 张已发布白底底图，按顺序作为主图和补充角度`;

  return (
    <div
      className="wb-prompt-modal-backdrop rp-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) onClose();
      }}
    >
      <section
        className="wb-prompt-modal wb-white-picker rp-picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="wb-prompt-popover-head rp-picker-head">
          <div>
            <span className="wb-modal-eyebrow rp-modal-eyebrow">{eyebrow}</span>
            <strong>{title}</strong>
            <small>{resolvedSubtitle}</small>
          </div>
          <button type="button" aria-label="关闭图片库选择器" disabled={loading} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        {removedNotice && (
          <p className="rp-picker-notice" role="status">
            {removedNotice}
          </p>
        )}

        {loadError ? (
          <p className="rp-picker-state is-error" role="alert">
            图片库加载失败
          </p>
        ) : !items ? (
          <p className="rp-picker-state" role="status">
            正在加载图片库…
          </p>
        ) : (
          !items.length && <p className="rp-picker-state">暂无已发布的白底底图</p>
        )}

        <div className="wb-white-picker-grid rp-picker-grid">
          {items?.map((item) => {
            const active = selected.some((ref) => ref.resourceId === item.id);
            return (
              <button
                type="button"
                key={item.id}
                aria-pressed={active}
                disabled={loading || (!active && selected.length >= limit)}
                className={`wb-white-picker-item rp-picker-item ${active ? "is-selected" : ""}`}
                onClick={() => toggle(item)}
              >
                <span className="wb-picker-check rp-picker-check">{active ? "✓" : ""}</span>
                {item.previewUrl && <img src={item.previewUrl} alt={item.title} />}
                <strong>{item.title}</strong>
                <small>
                  白底底图 · {item.resourceVersionId.slice(0, 8)}
                </small>
              </button>
            );
          })}
        </div>

        {selected.length > 0 && (
          <div className="wb-white-picker-order rp-picker-order">
            <strong>已选顺序（{selected.length}/{limit}）</strong>
            {selected.map((item, index) => (
              <div key={item.resourceId}>
                <span>
                  {index + 1}. {item.title ?? item.resourceId.slice(0, 8)}
                </span>
                <button type="button" disabled={loading || index === 0} onClick={() => move(index, -1)}>
                  上移
                </button>
                <button
                  type="button"
                  disabled={loading || index === selected.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <button
                  type="button"
                  className="rp-picker-remove-btn"
                  disabled={loading}
                  onClick={() => removeSelected(item.resourceId)}
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="wb-prompt-modal-actions rp-picker-actions">
          <button type="button" disabled={loading} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="wb-primary-action rp-primary-action"
            disabled={(!allowEmpty && !selected.length) || loading}
            onClick={() => void confirm()}
          >
            {loading ? "保存中…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
