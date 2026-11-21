import { useEffect, useState } from "react";
import { listingCopyApi, type ApiListingContent, type ApiListingJob, type ApiPlatformProfile } from "../../api/client";
import { StudioDialog } from "../suite-studio/StudioDialog";
import { studioApi, type StudioState } from "../suite-studio/studio";
import { ListingCopyResult, listingMessage, useListingCopyJob } from "./ListingCopyResult";
import "./listing-copy.css";

function DrawerJob({ id, profiles, setBusy }: {
  id: string;
  profiles: ApiPlatformProfile[];
  setBusy: (busy: boolean) => void;
}) {
  const { job, setJob, readError, retry } = useListingCopyJob(id);
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
      {job ? <ListingCopyResult job={job} blocked={busy} domestic={profiles.some((p) => p.code === job.platform && p.marketScope === "domestic")}
        save={(content: ApiListingContent) => void run(() => listingCopyApi.save(id, content))}
        regenerate={() => void run(() => listingCopyApi.generate(id, "regenerate"))} />
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
  const [discovered, setDiscovered] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const id = state.listingCopy?.id ?? discovered;
  const enabled = state.pipeline?.config.listingCopy === true;
  useEffect(() => {
    if (id || !enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setWaiting(true);
    async function readBatch() {
      try {
        const next = await studioApi.state(suiteId);
        if (!active) return;
        if (next.listingCopy) setDiscovered(next.listingCopy.id);
        else if (next.pipeline?.status === "running") { timer = setTimeout(readBatch, 1000); return; }
      } catch (error) {
        if (active) setNotice(listingMessage(error));
      }
      if (active) setWaiting(false);
    }
    void readBatch();
    return () => { active = false; clearTimeout(timer); };
  }, [id, enabled, suiteId, retry]);
  return (
    <StudioDialog title="商品上架文案" className="lc-drawer" close={() => { if (!busy) close(); }}>
      <p className="lc-batch-name">{state.suite.name}</p>
      {id ? <DrawerJob key={id} id={id} profiles={profiles} setBusy={setBusy} />
        : notice ? <p role="alert" className="lc-error">{notice} <button onClick={() => { setNotice(""); setRetry((n) => n + 1); }}>重试读取</button></p>
        : <p role="status">{waiting ? "正在等待本批次的文案任务…" : "本批次暂无上架文案。"}</p>}
    </StudioDialog>
  );
}
