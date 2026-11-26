import assert from "node:assert/strict";
import test from "node:test";
import { offlineCanvas, seedGeneratedCanvas } from "./offline-canvas-fixture.mjs";

test("编辑已提交但回包丢失时，原样点击复用子卡，改动提示词后才创建新子卡", async (t) => {
  const { api, url, page } = await offlineCanvas(t);
  const { suiteId, tasks: [taskId] } = await seedGeneratedCanvas(api, 1);
  await page.goto(url + `create/canvas/${suiteId}`);
  const dialog = page.getByRole("dialog", { name: "图片编辑器" });
  const submit = dialog.getByRole("button", { name: "生成", exact: true });
  const keys = [];
  const receipts = [];
  await page.route("**/image-editor/sessions/*/submit", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    receipts.push((await response.json()).data);
    if (keys.length === 1 || keys.length === 3) await route.abort("connectionreset");
    else await route.fulfill({ response });
  });
  for (const changePrompt of [false, true]) {
    await page.locator(".wb-task-card:not(.wb-edit-child-card) .wb-card-edit").click();
    const area = dialog.getByLabel("调整要求");
    await area.fill("浅蓝色背景");
    const lost = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/submit"));
    await submit.click();
    await lost;
    if (changePrompt) await area.fill("深绿色背景");
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
  }
  assert.equal(keys.length, 4);
  assert.equal(keys[0], keys[1]);
  assert.equal(receipts[0].attempt.id, receipts[1].attempt.id);
  assert.notEqual(keys[1], keys[2]);
  assert.notEqual(keys[2], keys[3]);
  assert.equal(receipts[3].snapshot.operations[0].payload.prompt, "深绿色背景");
  const children = await api.request("GET", `/api/image-editor/source-cards/${taskId}/tasks`);
  assert.equal(children.body.data.length, 3);
  assert.ok(children.body.data.every((child) => child.attempts.length === 1));
});
