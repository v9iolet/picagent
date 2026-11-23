import { useEffect, useState } from "react";
import { suiteApi, type ApiSuite } from "../api/client";
import { AppShell } from "../components/AppShell";
import { createTools } from "../features/create/tool-registry";
import { Icon } from "./shared";
import "../components/suite-studio/studio.css";
import "./CanvasListPage.css";

export function CanvasListPage({ navigate }: { navigate: (to: string) => void }) {
  const [canvases, setCanvases] = useState<ApiSuite[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    suiteApi.listCanvases()
      .then((items) => { if (active) setCanvases(items.filter((item) => item.origin !== "replica")); })
      .catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [loadVersion]);

  async function createCanvas() {
    setCreating(true);
    setCreateError("");
    try {
      const canvas = await suiteApi.create("未命名画布", "canvas");
      navigate(`/create/canvas/${canvas.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "画布创建失败");
      setCreating(false);
    }
  }

  const href = (canvas: ApiSuite) => `/create/canvas/${canvas.id}`;
  return (
    <AppShell activeNav="create" crumbs={[{ label: "创建", to: "/create/suite" }, { label: "生图画布" }]} navigate={navigate} fullHeight>
      <div className="ss-layout canvas-list-layout">
        <nav className="ss-tools" aria-label="创作功能">
          {createTools.map((tool) => (
            <a key={tool.id} href={tool.path} aria-current={tool.id === "canvas" ? "page" : undefined} onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              navigate(tool.path);
            }}><Icon name={tool.icon} />{tool.label}</a>
          ))}
        </nav>
        <main className="canvas-list">
          <header>
            <h1>生图画布</h1>
            <button type="button" className="ss-primary" disabled={creating} onClick={() => void createCanvas()}><Icon name="image" />{creating ? "正在创建…" : "新建空白画布"}</button>
          </header>
          {createError && <p role="alert">{createError}</p>}
          {loadError ? <p role="alert">画布列表加载失败 <button type="button" onClick={() => { setLoadError(false); setLoadVersion((n) => n + 1); }}>重试</button></p>
            : !canvases ? <p role="status">正在加载画布…</p>
              : !canvases.length ? <p>暂无画布</p> : (
                <ul aria-label="画布列表">
                  {canvases.map((canvas) => (
                    <li key={canvas.id}>
                      <a href={href(canvas)} onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        navigate(href(canvas));
                      }}>
                        <span className="canvas-cover">{canvas.coverPreviewUrl ? <img src={canvas.coverPreviewUrl} alt="" loading="lazy" /> : <Icon name="columns" />}</span>
                        <span><strong>{canvas.name}</strong><small>{canvas.origin === "canvas" ? "自由画布" : "商品套图"} · {canvas.taskCount ?? 0} 张任务卡</small></span>
                        <Icon name="arrow-right" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
        </main>
      </div>
    </AppShell>
  );
}
