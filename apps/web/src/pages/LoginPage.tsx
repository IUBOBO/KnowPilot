import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

/**
 * 登录页（阶段 4B）。**在 Layout 之外** —— 未登录的人不该看到侧栏导航。
 *
 * 【为什么自己不发请求，而是调 useAuth().login】登录不只是"发一次 POST"：
 *   成功后要填权限、让守卫放行、让侧栏出现用户名。这些状态都归 AuthContext，
 *   页面只负责收集输入与显示错误。
 *
 * 【为什么失败的文案不由这里决定】服务端对"用户不存在"与"密码错"返回
 *   完全一致的错误（同一个 code、同一句话）—— 这是防用户名枚举的要求。
 *   页面若自作主张分开提示，等于把这个信息又泄露回界面。
 */
export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // 只接受站内路径。`next` 是查询串里来的，而 `//evil.com` 是**协议相对 URL**，
  // 浏览器会当成跨站地址 —— 一个能被别人拼出来的跳转地址就是现成的钓鱼材料。
  const rawNext = params.get('next') ?? '';
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  // 已经登录的人不该看到登录表单：多半是手输了 /login，或者登录成功后按了后退。
  if (status === 'authenticated') return <Navigate to={next} replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username.trim() === '' || password === '') {
      // 空表单不发请求：一次注定失败的往返只会让用户多等一会儿，
      // 而服务端对空用户名/空密码的答复（"用户名或密码不正确"）对
      // 用户也没有帮助 —— 他知道自己没填。
      setError(new Error('请填写用户名与密码。'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={(e) => void onSubmit(e)}>
        <div className="auth-brand">
          <img className="brand-logo" src="/brand-mark.svg" alt="" width={44} height={44} />
          <div>
            <div className="auth-title">KnowPilot</div>
            <p className="brand-sub">让研究知识，持续生长</p>
          </div>
        </div>

        <h1 className="auth-heading">登录 KnowPilot</h1>

        {status === 'loading' ? (
          <p className="dim" style={{ margin: 0 }}>正在确认登录状态…</p>
        ) : (
          <>
            <label className="field">
              <span>用户名</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="请输入用户名"
                disabled={busy}
              />
            </label>

            <label className="field">
              <span>密码</span>
              <span className="password-control">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="password-visibility"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  disabled={busy}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </span>
            </label>

            {error !== null && <LoginError error={error} />}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? '登录中…' : '登录'}
            </button>

            <p className="auth-foot">
              账号由管理员创建；如需重置密码，请联系管理员。
            </p>
          </>
        )}
      </form>
    </div>
  );
}

/**
 * 错误展示。
 *
 * 分两类，因为它们能给出的信息不一样：
 *   · 后端返回的 `ApiError` —— 带请求 ID，用户报问题时能对上服务端日志；
 *   · 前端自己拦下的（空表单）—— 没有请求，也就没有 ID 可给。
 * 把前者的 ID 省掉、或给后者编一个 "-"，都会让人在日志里白找一遍。
 */
function LoginError({ error }: { error: unknown }) {
  if (error instanceof ApiError) return <ErrorNotice error={error} />;
  return (
    <div className="notice err">
      <p className="notice-body" style={{ margin: 0 }}>
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  );
}
