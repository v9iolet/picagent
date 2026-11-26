import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createSuiteStudioApp } from "../server/app.js";
import { AuthService, loadAuthServiceOptionsFromEnv } from "../server/auth/auth-service.js";
import { dispatchJsonRequest } from "../server/http/json-request.js";
import { dispatchInputImageUpload } from "../server/multipart.js";
import { MemoryAuthRepository } from "../server/repositories/memory-auth-repository.js";
import { MemorySuiteRepository } from "../server/repositories/memory-suite-repository.js";
import { MemoryStorage } from "../server/storage/memory-storage.js";
import { sanitizeNextPath } from "../src/context/AuthContext.tsx";

test("登录回跳只接受站内路径，保留业务页的查询参数和锚点", () => {
  for (const path of [null, "", "assets", "https://example.org", "//example.org", "/\\example.org",
    "/login", "/login/", "/login/again", "/login?next=/", "/login#top", "/assets/../login"]) {
    assert.equal(sanitizeNextPath(path), "/");
  }
  assert.equal(sanitizeNextPath("/assets?q=studio#first"), "/assets?q=studio#first");
});

async function fixture(t) {
  let time = Date.now();
  const codes = ["AB2Z", "D3EF", "GH4J", "K5LM", "N6PQ", "R7ST"];
  let index = 0;
  let currentCode;
  const authService = new AuthService(new MemoryAuthRepository(), {
    ...loadAuthServiceOptionsFromEnv({}),
    now: () => new Date(time),
    generateCaptchaCode: () => (currentCode = codes[index++ % codes.length]),
  });
  await authService.ensureDefaultAdmin();
  const api = createSuiteStudioApp({ authService, repository: new MemorySuiteRepository(), storage: new MemoryStorage() });
  const calls = [];
  const vite = await createServer({
    cacheDir: "node_modules/.vite-browser-auth",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "offline-admin-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (!url.pathname.startsWith("/api/")) return next();
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const bytes = Buffer.concat(chunks);
            const upload = req.method === "POST" && await dispatchInputImageUpload(api, url.pathname, bytes, req.headers);
            const result = upload || await dispatchJsonRequest(api.request, req.method, url, req.headers, bytes);
            calls.push({ path: url.pathname, status: result.status });
            res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
            res.end(result.raw ?? JSON.stringify(result.body));
          } catch (error) { next(error); }
        });
      },
    }],
  });
  t.after(() => vite.close());
  await vite.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  return { page, url: vite.resolvedUrls.local[0], calls, authService, code: () => currentCode, advance: ms => time += ms };
}

test("管理员登录、一次性验证码、刷新保持会话、撤销和退出登录", async t => {
  const { page, url, calls, authService, code, advance } = await fixture(t);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const suitePath = "/create/suite";
  const loginUrl = new URL("/login?next=%2Fcreate%2Fsuite", url).href;
  const suiteUrl = new URL(suitePath, url).href;
  const username = page.getByRole("textbox", { name: "账号", exact: true });
  const password = page.locator('[name="password"]');
  const captcha = page.locator('[name="captchaCode"]');
  const image = page.getByRole("img", { name: "图形验证码" });
  const submit = page.getByRole("button", { name: "登录工作台" });
  const logout = page.getByRole("button", { name: "退出登录" });
  async function waitForImage(previous = "") {
    await page.waitForFunction(src => {
      const image = document.querySelector('img[alt="图形验证码"]');
      return image?.naturalWidth > 0 && image.src !== src;
    }, previous);
    assert.equal(await captcha.inputValue(), "");
  }
  async function failedLogin(input, expectedError) {
    const previous = await image.getAttribute("src");
    await captcha.fill(input);
    await submit.click();
    await page.getByRole("alert").filter({ hasText: expectedError }).waitFor();
    await waitForImage(previous);
    assert.equal(page.url(), loginUrl);
  }
  async function cookieHeader() {
    const cookie = (await page.context().cookies()).find(c => c.name === "picagent_session");
    assert.ok(cookie?.httpOnly);
    return { cookie: cookie.name + "=" + cookie.value };
  }

  // An unavailable session endpoint must leave the protected page unmounted.
  await page.clock.install();
  await page.route("**/api/auth/session", route => route.abort());
  await page.goto(suiteUrl);
  await page.getByRole("alert").filter({ hasText: "无法验证登录状态" }).waitFor();
  assert.equal(await page.locator(".pa-shell").count(), 0);
  assert.equal(calls.length, 0);
  await page.unroute("**/api/auth/session");
  await page.getByRole("button", { name: "重新验证" }).click();
  await page.waitForURL(loginUrl);
  await waitForImage();
  assert.equal(await page.title(), "管理员登录 · PicAgent");
  assert.ok(await page.locator('img[src="/logo.svg"]').evaluate(img => img.complete && img.naturalWidth > 0));
  assert.match(await image.getAttribute("src"), /^data:image\/svg\+xml/);
  assert.doesNotMatch(await page.locator("body").innerText(), /注册|创建账号|忘记密码|找回密码/);
  assert.ok(calls.every(call => call.path.startsWith("/api/auth/")));
  assert.equal(await username.evaluate(input => input === document.activeElement), true);
  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.clock.fastForward(181000);
  await page.getByText("验证码已过期，点击刷新").waitFor();
  assert.equal(await submit.isDisabled(), true);
  for (const name of ["点击图片刷新验证码", "刷新验证码"]) {
    const previous = await image.getAttribute("src");
    await page.getByRole("button", { name, exact: true }).click();
    await waitForImage(previous);
  }
  await username.fill("admin");
  await password.fill("woshisheng_666");
  await page.getByRole("button", { name: "显示密码" }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: "隐藏密码" }).click();
  await failedLogin("XXXX", "验证码错误，请重新输入");
  advance(181000);
  await failedLogin(code(), "验证码已过期，请刷新后重试");
  await password.fill("wrong");
  await failedLogin(code(), "账号或密码错误");
  assert.equal(await page.getByText("登录状态已失效，请重新登录").count(), 0);
  await password.fill("woshisheng_666");
  await captcha.fill(code());
  await captcha.press("Enter");
  await page.waitForURL(suiteUrl);
  await page.locator(".pa-topbar-right").getByText("admin", { exact: true }).waitFor();
  await logout.waitFor();
  await page.reload();
  await logout.waitFor();
  assert.equal(page.url(), suiteUrl);

  // Use the same session cookie for business JSON, multipart XHR and the stored image.
  const suiteId = await page.evaluate(async () => {
    const { suiteApi } = await import("/src/api/suites.ts");
    const suite = await suiteApi.create("鉴权测试商品");
    const photo = await fetch("/assets/gan65-product.jpg").then(r => r.blob());
    const uploaded = await suiteApi.upload(suite.id, new File([photo], "product.jpg", { type: photo.type }), 1);
    const original = await fetch("/api/suites/" + suite.id + "/input-images/" + uploaded.id + "/original");
    if (original.status !== 200 || !(await original.blob()).size) throw new Error("无法读取上传的原图");
    return suite.id;
  });
  assert.ok(calls.some(call => call.path === "/api/suites/" + suiteId + "/input-images" && call.status === 201));
  assert.equal((await page.request.get(new URL("/api/suites", url).href)).status(), 200);

  const uploadTab = await page.context().newPage();
  uploadTab.on("pageerror", error => errors.push(error.message));
  await uploadTab.goto(new URL("/login?next=%2Fcreate%2Fsuite", url).href);
  await uploadTab.waitForURL(suiteUrl);
  await uploadTab.getByRole("button", { name: "退出登录" }).waitFor();
  await authService.logout(await cookieHeader());
  const uploadStatus = await uploadTab.evaluate(async id => {
    const { suiteApi } = await import("/src/api/suites.ts");
    try {
      await suiteApi.upload(id, new File([""], "product.jpg", { type: "image/jpeg" }), 1);
    } catch (error) { return error.status; }
  }, suiteId);
  assert.equal(uploadStatus, 401);
  await uploadTab.waitForURL(loginUrl);
  await uploadTab.getByText("登录状态已失效，请重新登录").waitFor();
  await uploadTab.close();
  const unauthorized = page.waitForResponse(r => r.url().includes("/api/product-cards") && r.status() === 401);
  await page.getByRole("link", { name: "商品库" }).click();
  await unauthorized;
  await page.waitForURL(new URL("/login?next=%2Fproducts", url).href);
  await page.getByRole("status").filter({ hasText: "登录状态已失效，请重新登录" }).waitFor();
  await waitForImage();
  await username.fill("admin");
  await password.fill("woshisheng_666");
  await captcha.fill(code());
  await submit.click();
  await page.waitForURL(new URL("/products", url).href);
  const oldCookie = await cookieHeader();
  await logout.click();
  await page.waitForURL(new URL("/login?next=%2Fproducts", url).href);
  await waitForImage();
  assert.equal(await page.getByText("登录状态已失效，请重新登录").count(), 0);
  assert.equal((await page.context().cookies()).some(c => c.name === "picagent_session"), false);
  const replay = await page.request.get(new URL("/api/suites", url).href, { headers: oldCookie });
  assert.equal(replay.status(), 401);
  assert.deepEqual(errors, []);
});
