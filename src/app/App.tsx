import { ToastProvider } from "../components/ui/ToastProvider";
import { AppConfigProvider } from "../context/AppConfigContext";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

const AplusStudioPage = lazy(() => import("../pages/AplusStudioPage").then(module => ({ default: module.AplusStudioPage })));
const HomePage = lazy(() => import("../pages/HomePage").then(module => ({ default: module.HomePage })));
const ModelSettingsPage = lazy(() => import("../pages/ModelSettingsPage").then(module => ({ default: module.ModelSettingsPage })));
const SuiteStudioPage = lazy(() => import("../pages/SuiteStudioPage").then(module => ({ default: module.SuiteStudioPage })));
const BoardPage = lazy(() => import("../pages/BoardPage").then(module => ({ default: module.BoardPage })));
const CanvasListPage = lazy(() => import("../pages/CanvasListPage").then(module => ({ default: module.CanvasListPage })));
const ImageAssetsPage = lazy(() => import("../pages/ImageAssetsPage").then(module => ({ default: module.ImageAssetsPage })));
const ProductLibraryPage = lazy(() => import("../pages/ProductLibraryPage").then(module => ({ default: module.ProductLibraryPage })));
const PromptTemplatesPage = lazy(() => import("../pages/PromptTemplatesPage").then(module => ({ default: module.PromptTemplatesPage })));
const ReplicaStudioPage = lazy(() => import("../pages/ReplicaStudioPage").then(module => ({ default: module.ReplicaStudioPage })));
const ReversePage = lazy(() => import("../pages/ReversePage").then(module => ({ default: module.ReversePage })));

const readLocation = () => ({ path: window.location.pathname, search: window.location.search });

export function App() {
  const [{ path, search }, setLocation] = useState(readLocation);

  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: { replace?: boolean }) => {
    window.history[options?.replace ? "replaceState" : "pushState"]({}, "", to);
    setLocation(readLocation());
    if (!options?.replace) window.scrollTo({ top: 0 });
  }, []);

  return (
    <AppConfigProvider>
      <ToastProvider>
        <Suspense fallback={<main role="status">正在加载页面…</main>}>
          <RoutePage path={path} search={search} navigate={navigate} />
        </Suspense>
      </ToastProvider>
    </AppConfigProvider>
  );
}

function RoutePage({ path, search, navigate }: {
  path: string;
  search: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}) {
  const legacy = path.match(/^\/suites\/([^/]+)\/?$/);
  const legacyBoard = path.match(/^\/suites\/([^/]+)\/board\/?$/);
  const legacyListing = /^\/create\/listing-copy(?:\/[^/]+)?\/?$/.test(path);
  const legacyReverseRoot = /^\/reverse\/?$/.test(path);
  const canonical = legacyBoard ? `/create/canvas/${legacyBoard[1]}`
    : legacy && legacy[1] !== "new" ? `/create/suite/${legacy[1]}`
    : legacyReverseRoot ? "/create/replica"
    : legacy || legacyListing ? "/create/suite" : path;
  useEffect(() => {
    if (path === canonical) return;
    navigate(canonical + search + window.location.hash, { replace: true });
  }, [path, canonical, search, navigate]);

  const reverseId = path.match(/^\/reverse\/([^/]+)/)?.[1];
  if (path === "/") {
    const sessionId = new URLSearchParams(search).get("session")?.trim() || undefined;
    return <HomePage sessionId={sessionId} navigate={navigate} />;
  }
  if (path === "/settings" || path === "/settings/preferences") return <ModelSettingsPage preferences={path.endsWith("/preferences")} navigate={navigate} />;
  if (/^\/create\/canvas\/?$/.test(canonical)) return <CanvasListPage navigate={navigate} />;
  const canvasId = canonical.match(/^\/create\/canvas\/([^/]+)\/?$/)?.[1];
  if (canvasId) return <BoardPage key={canvasId} suiteId={canvasId} search={search} navigate={navigate} />;
  if (path === "/products" || path === "/products/") {
    const selectedId = new URLSearchParams(search).get("selected")?.trim() || undefined;
    return <ProductLibraryPage initialSelectedId={selectedId} navigate={navigate} />;
  }
  if (path === "/assets") return <ImageAssetsPage navigate={navigate} />;
  if (path === "/templates") return <PromptTemplatesPage navigate={navigate} />;
  if (path === "/style-library") {
    const tab = new URLSearchParams(search).get("tab");
    return tab === "templates" ? <PromptTemplatesPage navigate={navigate} /> : <ImageAssetsPage navigate={navigate} />;
  }
  if (/^\/create\/replica\/?$/.test(canonical)) {
    const replicaParams = new URLSearchParams(search);
    const replicaSuiteId = replicaParams.get("suite")?.trim() || undefined;
    const replicaProductCardId = replicaParams.get("productCardId")?.trim() || undefined;
    return (
      <ReplicaStudioPage
        suiteId={replicaSuiteId}
        initialProductCardId={replicaProductCardId}
        navigate={navigate}
      />
    );
  }
  if (/^\/create\/aplus\/?$/.test(canonical)) {
    const params = new URLSearchParams(search);
    return (
      <AplusStudioPage
        suiteId={params.get("suite")?.trim() || undefined}
        initialProductCardId={params.get("productCardId")?.trim() || undefined}
        navigate={navigate}
      />
    );
  }
  if (reverseId) return <ReversePage planId={reverseId} navigate={navigate} />;
  const pathSuiteId = canonical.match(/^\/create\/suite\/([^/]+)\/?$/)?.[1];
  const suiteParams = /^\/create\/suite\/?$/.test(canonical) ? new URLSearchParams(search) : null;
  const querySuiteId = suiteParams?.get("suite")?.trim() || undefined;
  const suiteProductCardId = suiteParams?.get("productCardId")?.trim() || undefined;
  return (
    <SuiteStudioPage
      suiteId={pathSuiteId ?? querySuiteId}
      initialProductCardId={suiteProductCardId}
      navigate={navigate}
    />
  );
}
