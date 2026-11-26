import { usePolling } from "../../hooks/usePolling";
import { useState } from "react";
import { listingCopyApi, type ApiListingContent, type ApiListingJob, type ApiPlatformProfile } from "../../api/client";
import { StudioDialog } from "../suite-studio/StudioDialog";
import { studioApi, type StudioState } from "../suite-studio/studio";
import { ListingCopyResult, listingMessage, useListingCopyJob } from "./ListingCopyResult";
import "./listing-copy.css";

function DrawerJob({ id, initial, profiles, setBusy }: {
  id: string;
  initial?: ApiListingJob;
  profiles: ApiPlatformProfile[];
  setBusy: (busy: boolean) => void;
}) {
  const { job, setJob, readError, retry } = useListingCopyJob(id, initial);
  const profile = profiles.find((p) => p.code === job?.platform);
  const [busy, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const run = async (action: () => Promise<ApiListingJob>) => {
    setWorking(true);
    setBusy(true);
    setNotice("");
    try { setJob(await action()); }
    catch (error) { setNotice(listingMessage(error)); }
    finally { setWorking(false); setBusy(false); }
  };
  return (
    <>
      {notice && <p role="alert" className="lc-error">{notice}</p>}
      {readError && <p role="alert" className="lc-error">{readError} <button onClick={retry}>重试读取</button></p>}
      {job ? <ListingCopyResult job={job} blocked={busy} domestic={profile?.marketScope === "domestic"}
        rules={profile?.listingCopyRules}
        save={(content: Partial<ApiListingContent>) => void run(() => listingCopyApi.save(id, content))}
        regenerate={() => void run(() => listingCopyApi.regenerate(id))} />
        : !readError && <p role="status">正在读取文案…</p>}
    </>
  );
}

export function ListingCopyDrawer({ state, profiles, close }: {
  state: StudioState;
  profiles: ApiPlatformProfile[];
  close: () => void;
}) {
  const suiteId = state.suite.id;
  const [discovered, setDiscovered] = useState<{ id: string; job?: ApiListingJob }>();
  const [checking, setChecking] = useState(true);
  const [readError, setReadError] = useState("");
  const [createError, setCreateError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = state.listingCopy?.id ?? discovered?.id;
  const autoListingPending = state.pipeline?.config.listingCopy === true && state.pipeline.status === "running";
  usePolling(async signal => {
    const next = await studioApi.state(suiteId, signal);
    if (signal.aborted) return;
    if (next.listingCopy) setDiscovered({ id: next.listingCopy.id });
    else if (next.pipeline?.config.listingCopy && next.pipeline.status === "running") return;
    setChecking(false);
  }, {
    enabled: !id && checking && !readError,
    initialDelayMs: 0,
    intervalMs: 1000,
    onError: error => {
      setReadError(listingMessage(error));
      setChecking(false);
    },
  }, [suiteId]);

  async function generate() {
    setBusy(true);
    setCreateError("");
    try {
      const job = await listingCopyApi.generateForSuite(suiteId);
      setDiscovered({ id: job.id, job });
    } catch (error) {
      setCreateError(listingMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudioDialog title="商品上架文案" className="lc-drawer" close={close} dismissDisabled={busy}>
      <p className="lc-batch-name">{state.suite.name}</p>
      {id ? <DrawerJob key={id} id={id} initial={discovered?.id === id ? discovered.job : undefined} profiles={profiles} setBusy={setBusy} />
        : readError ? <p role="alert" className="lc-error">{readError} <button onClick={() => { setReadError(""); setChecking(true); }}>重试读取</button></p>
        : checking ? <p role="status">{autoListingPending ? "正在等待本批次的文案任务…" : "正在读取文案…"}</p>
        : <div className="lc-generate">
          <p>本批次暂无上架文案。可用该批次的商品实拍原图和卖点生成文案。</p>
          {createError && <p role="alert" className="lc-error">{createError}</p>}
          <button className="ss-primary" disabled={busy} onClick={() => void generate()}>
            {busy ? "正在提交…" : "一键生成上架文案"}
          </button>
        </div>}
    </StudioDialog>
  );
}
