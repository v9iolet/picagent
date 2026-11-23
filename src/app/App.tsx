import { useCallback, useEffect, useMemo, useState } from "react";
import { ModelSettingsPage } from "../pages/ModelSettingsPage";
import { SuiteStudioPage } from "../pages/SuiteStudioPage";
import { BoardPage } from "../pages/BoardPage";
import { CanvasListPage } from "../pages/CanvasListPage";
import { ImageAssetsPage } from "../pages/ImageAssetsPage";
import { PromptTemplatesPage } from "../pages/PromptTemplatesPage";
import { ReversePage } from "../pages/ReversePage";

const readLocation = () => ({ path: window.location.pathname, search: window.location.search });

export function App() {
  const [{ path, search }, setLocation] = useState(readLocation);

  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const reverseId = useMemo(() => path.match(/^\/reverse\/([^/]+)/)?.[1], [path]);
  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", to);
    setLocation(readLocation());
    if (!options?.replace) window.scrollTo({ top: 0 });
  }, []);

  const legacy = path.match(/^\/suites\/([^/]+)\/?$/);
  const legacyBoard = path.match(/^\/suites\/([^/]+)\/board\/?$/);
  const legacyListing = /^\/create\/listing-copy(?:\/[^/]+)?\/?$/.test(path);
  const canonical = legacyBoard ? `/create/canvas/${legacyBoard[1]}`
    : legacy && legacy[1] !== "new" ? `/create/suite/${legacy[1]}`
    : legacy || legacyListing || path === "/" ? "/create/suite" : path;
  useEffect(() => {
    if (path === canonical) return;
    window.history.replaceState({}, "", canonical + search + window.location.hash);
    setLocation(readLocation());
  }, [path, canonical, search]);

  if (path === "/settings" || path === "/settings/preferences") return <ModelSettingsPage preferences={path.endsWith("/preferences")} navigate={navigate} />;
  if (/^\/create\/canvas\/?$/.test(canonical)) return <CanvasListPage navigate={navigate} />;
  const canvasId = canonical.match(/^\/create\/canvas\/([^/]+)\/?$/)?.[1];
  if (canvasId) return <BoardPage key={canvasId} suiteId={canvasId} search={search} navigate={navigate} />;
  if (path === "/assets") return <ImageAssetsPage navigate={navigate} />;
  if (path === "/templates") return <PromptTemplatesPage navigate={navigate} />;
  if (path === "/style-library") {
    const tab = new URLSearchParams(search).get("tab");
    return tab === "templates" ? <PromptTemplatesPage navigate={navigate} /> : <ImageAssetsPage navigate={navigate} />;
  }
  if (path === "/reverse" || reverseId) return <ReversePage planId={reverseId} navigate={navigate} />;
  return <SuiteStudioPage suiteId={canonical.match(/^\/create\/suite\/([^/]+)\/?$/)?.[1]} navigate={navigate} />;
}
