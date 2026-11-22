import { useState } from "react";
import { SELLING_POINT_LAYOUTS, resolveSellingPointLayouts } from "../../../shared/selling-point-layouts";
import { SellingPointLayoutPreview } from "./SellingPointLayoutPreview";
import { StudioDialog } from "./StudioDialog";

type Props = {
  selectedIds: string[];
  maxCount: number;
  close: () => void;
  apply: (ids: string[]) => void;
};

export function SellingPointLayoutModal({ selectedIds, maxCount, close, apply }: Props) {
  const [selected, setSelected] = useState(() => resolveSellingPointLayouts(selectedIds, maxCount));

  function remove(id: string) {
    setSelected((layouts) => layouts.filter((layout) => layout.id !== id));
  }

  return (
    <StudioDialog title="选择卖点图版式" close={close} wide className="ss-layout-dialog">
      <div className="ss-layout-picker">
        <div className="ss-layout-options" aria-label="内置版式" role="group">
          {SELLING_POINT_LAYOUTS.map((layout) => {
            const order = selected.findIndex(({ id }) => id === layout.id) + 1;
            return (
              <button
                type="button"
                key={layout.id}
                className="ss-layout-option"
                aria-label={layout.name}
                aria-describedby={`layout-summary-${layout.id}`}
                aria-pressed={order > 0}
                disabled={order === 0 && selected.length >= maxCount}
                onClick={() => order ? remove(layout.id) : setSelected([...selected, layout])}
              >
                <span className="ss-layout-preview">
                  <SellingPointLayoutPreview id={layout.id} />
                  {order > 0 && <span className="ss-layout-order" aria-hidden="true">{order}</span>}
                </span>
                <strong>{layout.name}</strong>
                <small id={`layout-summary-${layout.id}`}>{layout.summary}</small>
              </button>
            );
          })}
        </div>
        <section className="ss-layout-selection" aria-label="版式选择摘要">
          <div className="ss-layout-selection-heading">
            <h3>已选版式</h3>
            <output aria-label="已选版式数量">{selected.length} / {maxCount}</output>
          </div>
          <p>每种版式生成 1 张，剩余卖点图 AI 补齐。</p>
          {selected.length > 0 ? (
            <>
              <ol aria-label="已选版式">
                {selected.map(({ id, name, tag }) => (
                  <li key={id}>
                    <div className="ss-layout-selection-item">
                      <div><strong>{name}</strong><small>{tag}</small></div>
                      <button type="button" aria-label={`移除 ${name}`} onClick={() => remove(id)}>×</button>
                    </div>
                  </li>
                ))}
              </ol>
              <button type="button" className="ss-layout-clear" onClick={() => setSelected([])}>清空</button>
            </>
          ) : (
            <div className="ss-layout-placeholder">
              <strong>暂未选择版式</strong>
              <small>卖点图将使用 AI 智能版式</small>
            </div>
          )}
        </section>
        <footer className="ss-layout-apply">
          <button type="button" className="ss-primary" onClick={() => apply(selected.map(({ id }) => id))}>
            应用 {selected.length} 个版式
          </button>
        </footer>
      </div>
    </StudioDialog>
  );
}
