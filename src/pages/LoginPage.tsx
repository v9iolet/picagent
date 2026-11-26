import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { authApi, type ApiCaptchaChallenge } from "../api/auth";
import { ApiHttpError } from "../api/http";
import { BrandLogo } from "../components/BrandLogo";
import { useAuth } from "../context/AuthContext";
import { Icon } from "./shared";
import "./LoginPage.css";

const workflows = ["商品建档", "电商套图", "爆品复刻", "A+ 详情", "精修画板"];

function StudioPanel() {
  return <aside className="login-studio" aria-label="PicAgent Studio">
    <div className="login-wordmark"><BrandLogo size={46} /><strong>PicAgent</strong><span>STUDIO</span></div>
    <div className="login-intro">
      <div className="login-viewfinder" aria-hidden="true">
        <div className="login-optics"><i /><i /><i /></div>
      </div>
      <h2>电商视觉<br />智能工作台</h2>
      <p>从商品资料到成套影像，在同一个工作台完成创作。</p>
      <ul>{workflows.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
    <footer><span aria-hidden="true" />PicAgent 内部工作台</footer>
  </aside>;
}

export function LoginPage({ nextPath, navigate }: {
  nextPath: string;
  navigate: (to: string, options: { replace: boolean }) => void;
}) {
  const auth = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [captchaCode, setCaptchaCode] = useState("");
  const [challenge, setChallenge] = useState<(ApiCaptchaChallenge & { deadline: number }) | null>(null);
  const [now, setNow] = useState(Date.now);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const captchaRequest = useRef(0);
  const captchaInput = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  const refreshCaptcha = useCallback(async () => {
    const requestId = ++captchaRequest.current;
    const requestedAt = Date.now();
    setChallenge(null);
    setCaptchaCode("");
    setCaptchaError("");
    try {
      const next = await authApi.getCaptcha();
      if (requestId === captchaRequest.current) {
        setNow(Date.now());
        // Count down the issued TTL even if the browser and server clocks differ.
        setChallenge({ ...next, deadline: requestedAt + next.ttlSeconds * 1000 });
      }
    } catch {
      if (requestId === captchaRequest.current) setCaptchaError("验证码加载失败，请点击刷新重试。");
    }
  }, []);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "管理员登录 · PicAgent";
    void refreshCaptcha();
    return () => {
      document.title = previousTitle;
      captchaRequest.current++;
    };
  }, [refreshCaptcha]);

  const seconds = challenge ? Math.max(0, Math.ceil((challenge.deadline - now) / 1000)) : 0;
  const counting = seconds > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || !challenge || !seconds) return;
    if (!username.trim() || !password || captchaCode.trim().length !== 4) {
      setError("请输入账号、密码和 4 位图形验证码。");
      return;
    }
    setError("");
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await auth.login({ username: username.trim(), password, captchaId: challenge.captchaId, captchaCode: captchaCode.trim() });
      navigate(nextPath, { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiHttpError ? cause.message : "登录失败，请检查网络连接后重试。");
      await refreshCaptcha();
      captchaInput.current?.focus();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const refreshing = !challenge && !captchaError;
  return <main className="login-page">
    <StudioPanel />
    <section className="login-form-area" aria-labelledby="login-heading">
      <div className="login-card">
        <div className="login-card-symbol" aria-hidden="true"><Icon name="lock" /></div>
        <h1 id="login-heading">管理员登录</h1>
        <p className="login-subtitle">仅限内部管理员账号访问</p>
        {auth.notice && <p className="login-notice" role="status">{auth.notice}</p>}
        <form onSubmit={submit}>
          <label htmlFor="login-username">账号</label>
          <input id="login-username" name="username" autoComplete="username" autoFocus required
            placeholder="请输入管理员账号" value={username} onChange={event => setUsername(event.target.value)} />
          <label htmlFor="login-password">密码</label>
          <div className="login-password">
            <input id="login-password" name="password" type={visible ? "text" : "password"} autoComplete="current-password"
              required placeholder="请输入密码" value={password} onChange={event => setPassword(event.target.value)} />
            <button type="button" aria-label={visible ? "隐藏密码" : "显示密码"} aria-pressed={visible} onClick={() => setVisible(!visible)}>
              <Icon name="eye" />
            </button>
          </div>
          <label htmlFor="login-captcha">图形验证码</label>
          <div className="login-captcha">
            <input id="login-captcha" name="captchaCode" autoComplete="off" spellCheck={false} maxLength={4} required
              aria-describedby="login-captcha-time" placeholder="4 位验证码" ref={captchaInput}
              value={captchaCode} onChange={event => setCaptchaCode(event.target.value)} />
            <button type="button" aria-label="点击图片刷新验证码" disabled={submitting || refreshing} onClick={refreshCaptcha}>
              {challenge ? <img src={challenge.imageDataUrl} alt="图形验证码" /> : refreshing ? "加载中…" : "点击重试"}
            </button>
          </div>
          <div className="login-captcha-meta">
            <span id="login-captcha-time">{challenge && (seconds ? seconds + "s 后过期" : "验证码已过期，点击刷新")}</span>
            <button type="button" onClick={refreshCaptcha} disabled={submitting || refreshing}>刷新验证码</button>
          </div>
          {(error || captchaError) && <div className="login-error" role="alert">{[error, captchaError].filter(Boolean).join(" ")}</div>}
          <button className="login-submit" type="submit" disabled={submitting || !challenge || !seconds}>
            {submitting ? "登录中…" : "登录工作台"}<Icon name="arrow-right" />
          </button>
        </form>
      </div>
    </section>
  </main>;
}
