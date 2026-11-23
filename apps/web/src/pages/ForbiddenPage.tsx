import { Link } from 'react-router-dom';
import { roleLabel, useAuth } from '../auth.tsx';

/**
 * 403 页。
 *
 * 【为什么要明确给出"需要什么"和"你现在是什么角色"】
 *   只说"你没有权限"的话，用户唯一能做的动作是来问开发；而绝大多数
 *   情况其实是**角色给错了**（该是导师的被建成了成员）。把这两条并排写出来，
 *   用户自己就能判断"是不是该找管理员改角色"，管理员也能一句话定位问题。
 *
 * 【为什么不自动跳回首页】自动跳转会让人以为链接坏了、或者页面在抽风。
 *   停在这里说明白，比把人弹回去强 —— 后者连"发生过什么"都不留痕迹。
 *
 * 【`needed` 是给人看的一句话，不是权限点本身】有些页面（如管理概览）
 *   对应的是"若干权限里的任意一个"，没有单一权限点可写。所以这里收字符串，
 *   由守卫负责把权限点格式化成这句话。
 */
export function ForbiddenPage({ needed }: { needed: string }) {
  const { user } = useAuth();

  return (
    <>
      <h1>
        没有权限 <span className="pill err">403</span>
      </h1>
      <p className="lead">当前角色没有访问这一页的权限。</p>
      <p className="dim" style={{ margin: '0 0 12px' }}>
        需要：{needed}
        {user === null
          ? '。'
          : `；你的角色是「${roleLabel(user.role)}」（${user.displayName}）。`}
      </p>

      <div className="card">
        <img className="forbidden-illustration" src="/empty-illustrations/no-access.svg" alt="" />
        <p style={{ margin: 0, color: 'var(--ink-3)' }}>
          这通常不是登录出了问题（登录没问题，服务端认得你），而是角色不够。
          需要访问的话，请联系管理员在「用户与权限」里调整你的角色。
        </p>
      </div>

      <p>
        <Link to="/">返回首页</Link>
      </p>
    </>
  );
}
