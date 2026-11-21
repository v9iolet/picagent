import { useEffect, useRef, useState, type ReactNode } from "react";
import { createIdempotencyKey, suiteApi } from "../../api/client";
import type { ResolvedDeliverySlot } from "../../../shared/workbench-delivery";
import { message } from "./studio";

export function StudioDialog({
  title,
  close,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={"ss-dialog" + (wide ? " wide" : "")}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={close} aria-label="关闭">
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
type Block = Awaited<ReturnType<typeof suiteApi.recognizeImageEditText>>["blocks"][number];
export function EditTextDialog({
  card,
  close,
  submitted,
}: {
  card: ResolvedDeliverySlot;
  close: () => void;
  submitted: (id: string) => void;
}) {
  const [session] = useState(() => createIdempotencyKey());
  const [blocks, setBlocks] = useState<Block[]>([]),
    [values, setValues] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState("正在识别图片文字…"),
    [busy, setBusy] = useState(false);
  // StrictMode may replay effects; issue one OCR request per dialog session.
  const ocr = useRef<ReturnType<typeof suiteApi.recognizeImageEditText> | null>(null);
  useEffect(() => {
    let live = true;
    ocr.current ??= suiteApi.recognizeImageEditText(session, card.versionId!);
    ocr.current
      .then((r) => {
        if (!live) return;
        if (r.status !== "succeeded") throw Error(r.error ?? "识字失败");
        setBlocks(r.blocks);
        setValues(Object.fromEntries(r.blocks.map((b) => [b.id, b.text])));
        setNotice(r.blocks.length ? "请逐行修改需要替换的文字。" : "未识别到可编辑文字。");
      })
      .catch((e) => {
        if (live) setNotice(message(e));
      });
    return () => {
      live = false;
    };
  }, [session, card.versionId]);
  const saved = useRef(new Set<string>());
  const changed = blocks.filter((b) => values[b.id] !== b.text);
  const submit = async () => {
    setBusy(true);
    try {
      // A fresh submission session is unnecessary: keep operations aligned even after a failed submit.
      for (const b of blocks) {
        if (!changed.includes(b)) {
          if (saved.current.has(b.id)) {
            await suiteApi.removeImageEditOperation(session, b.id);
            saved.current.delete(b.id);
          }
          continue;
        }
        await suiteApi.upsertImageEditOperation(session, {
          operationId: b.id,
          type: "change_text",
          sourceVersionId: card.versionId,
          summary: `替换「${b.text}」`,
          payload: {
            originalText: b.text,
            newText: values[b.id],
            region: { ...b.bounds, rotation: b.rotation },
            prompt: "仅替换指定文字，保留排版、字体和商品画面。",
          },
        });
        saved.current.add(b.id);
      }
      const result = await suiteApi.submitImageEdit(session, {
        sourceCardId: card.editChildTaskId ?? card.parentTaskId,
        sourceVersionId: card.versionId!,
        summary: `修改 ${changed.length} 处文字`,
      });
      submitted((result.childTask as { id: string }).id);
    } catch (e) {
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <StudioDialog
      title="编辑文字"
      close={() => {
        if (!busy) close();
      }}
    >
      <img className="ss-edit-preview" src={card.previewUrl!} alt={card.title} />
      <p role="status">{notice}</p>
      <fieldset disabled={busy}>
        {blocks.map((b) => (
          <label className="ss-line" key={b.id}>
            {b.text}
            <input
              value={values[b.id] ?? ""}
              onChange={(e) => setValues({ ...values, [b.id]: e.target.value })}
            />
          </label>
        ))}
      </fieldset>
      <button
        className="ss-primary"
        disabled={busy || !changed.length || changed.some((b) => !values[b.id]?.trim())}
        onClick={() => void submit()}
      >
        确认改字
      </button>
    </StudioDialog>
  );
}
