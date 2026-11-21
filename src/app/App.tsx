import { useEffect, useMemo, useState } from "react";
import { ModelSettingsPage } from "../pages/ModelSettingsPage";
import { SuiteStudioPage } from "../pages/SuiteStudioPage";
import { BoardPage } from "../pages/BoardPage";
import { CanvasListPage } from "../pages/CanvasListPage";
import { ImageAssetsPage } from "../pages/ImageAssetsPage";
import { PromptTemplatesPage } from "../pages/PromptTemplatesPage";
import { ReversePage } from "../pages/ReversePage";

export function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const reverseId = useMemo(() => path.match(/^\/reverse\/([^/]+)/)?.[1], [path]);
  const navigate = (to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0 });
  };

  const legacy = path.match(/^\/suites\/([^/]+)\/?$/);
  const legacyBoard = path.match(/^\/suites\/([^/]+)\/board\/?$/);
  const canonical = legacyBoard ? `/create/canvas/${legacyBoard[1]}` : legacy ? (legacy[1] === "new" ? "/create/suite" : `/create/suite/${legacy[1]}`) : path === "/" ? "/create/suite" : path;
  useEffect(() => {
    if (path === canonical) return;
    window.history.replaceState({}, "", canonical);
    setPath(canonical);
  }, [path, canonical]);

  if (path === "/settings" || path === "/settings/preferences") return <ModelSettingsPage preferences={path.endsWith("/preferences")} navigate={navigate} />;
  if (/^\/create\/canvas\/?$/.test(canonical)) return <CanvasListPage navigate={navigate} />;
  const canvasId = canonical.match(/^\/create\/canvas\/([^/]+)\/?$/)?.[1];
  if (canvasId) return <BoardPage key={canvasId} suiteId={canvasId} navigate={navigate} />;
  if (path === "/assets") return <ImageAssetsPage navigate={navigate} />;
  if (path === "/templates") return <PromptTemplatesPage navigate={navigate} />;
  if (path === "/style-library") {
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab === "templates" ? <PromptTemplatesPage navigate={navigate} /> : <ImageAssetsPage navigate={navigate} />;
  }
  if (path === "/reverse" || reverseId) return <ReversePage planId={reverseId} navigate={navigate} />;
  return <SuiteStudioPage suiteId={canonical.match(/^\/create\/suite\/([^/]+)\/?$/)?.[1]} navigate={navigate} />;
}
