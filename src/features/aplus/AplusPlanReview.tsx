import { useState } from "react";
import { APLUS_MODULES, type AplusModuleCode } from "../../../shared/aplus";
import { Icon } from "../../pages/shared";
import type { AplusPlanModule } from "./aplus-studio";

export function AplusPlanReview({
  globalPlan, modules, language, stale, busy, edited, blocked, onChange, onSave, onConfirm, onReplan,
}: {
  globalPlan: string | null;
  modules: AplusPlanModule[];
  language: string;
  stale: boolean;
  busy: boolean;
  edited: boolean;
  blocked: boolean;
  onChange: (modules: AplusPlanModule[]) => void;
  onSave: () => void;
  onConfirm: () => void;
  onReplan: () => void;
}) {
  const [dragged, setDragged] = useState<AplusModuleCode | null>(null);

  function move(code: AplusModuleCode, to: number) {
    const from = modules.findIndex(({ moduleCode }) => moduleCode === code);
    if (from < 0 || from === to || to < 0 || to >= modules.length) return;
    const next = [...modules];
    const [module] = next.splice(from, 1);
    next.splice(to, 0, module);
    onChange(next);
  }

  return (
    <section className="aplus-review" aria-label="方案确认">
      <div className="aplus-review-toolbar">
        <div>
          <h3>方案确认</h3>
          <small>{modules.length} 个模块</small>
        </div>
        <div className="aplus-review-actions">
          {stale ? (
            <button className="ss-primary" type="button" disabled={busy || blocked} onClick={onReplan}>方案已失效，重新规划</button>
          ) : (
            <>
              {edited && <button type="button" disabled={busy} onClick={onSave}>保存方案</button>}
              <button className="ss-primary" type="button" disabled={busy} onClick={onConfirm}>确认出图</button>
            </>
          )}
        </div>
      </div>
      {globalPlan && (
        <details className="aplus-global-plan" open>
          <summary>策划思路</summary>
          <p>{globalPlan}</p>
        </details>
      )}
      <ol className="aplus-plan-list">
        {modules.map(({ moduleCode, copyRequirements }, index) => {
          const name = APLUS_MODULES.find(({ code }) => code === moduleCode)?.name ?? moduleCode;
          return (
            <li
              key={moduleCode}
              className={dragged === moduleCode ? "is-dragging" : ""}
              onDragOver={(event) => {
                if (dragged && !busy && !stale) event.preventDefault();
              }}
              onDrop={(event) => {
                if (!dragged || busy || stale) return;
                event.preventDefault();
                move(dragged, index);
                setDragged(null);
              }}
            >
              <div className="aplus-section-heading">
                <strong className="aplus-plan-module-name">
                  <span
                    role="img"
                    aria-label={`拖动排序 ${name}`}
                    className="aplus-drag-handle"
                    draggable={!busy && !stale}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", moduleCode);
                      setDragged(moduleCode);
                    }}
                    onDragEnd={() => setDragged(null)}
                  ><Icon name="move" /></span>
                  {name}
                </strong>
                <div className="aplus-plan-actions">
                  <button type="button" aria-label={`上移 ${name}`} disabled={busy || stale || index === 0} onClick={() => move(moduleCode, index - 1)}>↑</button>
                  <button type="button" aria-label={`下移 ${name}`} disabled={busy || stale || index === modules.length - 1} onClick={() => move(moduleCode, index + 1)}>↓</button>
                  <button
                    type="button"
                    aria-label={`删除 ${name}`}
                    disabled={busy || stale || modules.length <= 1}
                    title={modules.length <= 1 ? "至少保留 1 个模块" : undefined}
                    onClick={() => onChange(modules.filter((item) => item.moduleCode !== moduleCode))}
                  ><Icon name="trash" /></button>
                </div>
              </div>
              {language === "none" ? <small>不加文字</small> : (
                <label>
                  文案要求
                  <textarea
                    aria-label={`${name}文案要求`}
                    rows={2}
                    value={copyRequirements}
                    disabled={busy || stale}
                    onChange={(event) => onChange(modules.map((item) => item.moduleCode === moduleCode
                      ? { ...item, copyRequirements: event.target.value }
                      : item))}
                  />
                </label>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
