/**
 * 评测运行目录的**删除保护**。
 *
 * 【为什么需要它：一个真实存在过的危险路径】
 *   改造前的 `run.ts` 把测试根写死成 `data/eval-verify`，
 *   每轮开跑先 `rmSync(ROOT, { recursive: true, force: true })`。
 *   那个路径是**常量**而不是"本轮新建的目录"，于是有三重风险：
 *     · 换机器 / 换盘符时它指向别处，甚至指向一个不存在的盘；
 *     · 若有人手滑把它配成 `data` 或仓库根，一次 `rmSync` 就是灾难性删除；
 *     · 两轮跑批并发时互相清空对方。
 *   改法是两条一起上：**每轮用 mkdtemp 建唯一目录**（不再有"清空固定目录"这个动作），
 *   外加本文件这道**删除闸门** —— 凡是递归删，先问三个问题，任一不满足就抛错、不删。
 *
 * 【为什么闸门不是"check 一下路径字符串就完事"】
 *   只比前缀挡不住 `data/eval-runs/../../knowpilot.db` 这类带 `..` 的路径 ——
 *   字符串前缀是匹配的，`resolve` 之后却指到别处。所以三条判据全部作用在
 *   **`resolve()` 之后的绝对路径**上，且目录内容也要验（标记文件），
 *   这样"路径对但其实是别人建的目录"这一种也挡得住。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

/** 运行目录名的前缀。闸门要求 basename 必须以它开头。 */
export const EVAL_RUN_PREFIX = 'eval-';

/**
 * 留在运行目录里的标记文件。
 *
 * 【为什么要它，而不只靠路径前缀】前缀只说明"名字像我们的"，不说明"这是我们建的"。
 *   有了标记文件，闸门才是在验"**这个目录确由本项目创建**"这件事本身。
 *   顺带还挡住一种静默事故：run 目录被人手工挪走 / 被别的东西占了同名路径，
 *   闸门会在删之前就拒绝，而不是先删了再发现不对。
 */
export const EVAL_ROOT_MARKER = '.eval-root';

/**
 * 判断 `target` 是否**可以**被递归删除。只回答"可不可以"，不做删除 —— 便于被断言脚本
 * 单独测（`verify-eval` 拿它测三条拒绝路径 + 一条放行路径，不需要真的去删东西）。
 *
 * 三条判据（全部作用在 resolve 之后的绝对路径上）：
 *   1. `target` 严格位于 `runsBase` **之内**（不是 runsBase 自身、不是它的祖先）；
 *   2. basename 以 `eval-` 开头；
 *   3. 目录里存在非空的 `.eval-root` 标记文件。
 *
 * 返回拒绝原因（`null` = 可以删）。**返回原因而不是抛错**，是为了让调用方决定
 * "拒绝时是抛错中止，还是只跳过一次清理并记账" —— 后者在跑批收尾时更合适。
 */
export function unsafeToDeleteReason(target: string, runsBase: string): string | null {
  const absTarget = resolve(target);
  const absBase = resolve(runsBase);

  // 判据 1：严格位于 runsBase 之内。用 `base + sep` 前缀比，`data/eval-runs-x`
  // 就不会被误判成 `data/eval-runs` 的子目录（纯字符串 startsWith 会）。
  if (!absTarget.startsWith(absBase + sep)) {
    return `不在允许的基目录内：${absTarget}（允许的基目录是 ${absBase}）`;
  }
  if (absTarget === absBase) {
    return `拒绝删除基目录自身：${absTarget}`;
  }

  // 判据 2：名字必须是我们的。
  if (!basename(absTarget).startsWith(EVAL_RUN_PREFIX)) {
    return `目录名不以 "${EVAL_RUN_PREFIX}" 开头：${basename(absTarget)}`;
  }

  // 判据 3：必须是我们建的（标记文件在且非空）。
  const marker = join(absTarget, EVAL_ROOT_MARKER);
  if (!existsSync(marker)) {
    return `缺少标记文件 ${EVAL_ROOT_MARKER}（这个目录不是本项目评测创建的）：${absTarget}`;
  }
  let runId: string;
  try {
    runId = readFileSync(marker, 'utf8').trim();
  } catch (err) {
    return `标记文件读不出来：${err instanceof Error ? err.message : String(err)}`;
  }
  if (runId === '') {
    return `标记文件为空（无法确认归属）：${absTarget}`;
  }
  return null;
}

/** 需要删就抛错版本。`unsafeToDeleteReason` 为 null 时静默通过。 */
export function assertSafeToDelete(target: string, runsBase: string): void {
  const reason = unsafeToDeleteReason(target, runsBase);
  if (reason !== null) {
    throw new Error(
      `拒绝删除：${reason}\n` +
        `这是评测运行目录的删除闸门（apps/server/src/eval/guard.ts）。` +
        `它只允许删除"在指定基目录之内、名字以 ${EVAL_RUN_PREFIX} 开头、且带 ${EVAL_ROOT_MARKER} 标记"的目录。`,
    );
  }
}

/**
 * 建一个本轮的运行目录：在 `runsBase` 下 `mkdtemp` 出唯一目录，并写下标记文件。
 *
 * 【为什么用 `mkdtempSync` 而不是"固定名字 + 先删后建"】固定名字正是 K-10 的病根：
 *   它让"删除"成为每轮的必做动作，而这个动作指向一个不属于本轮的路径。
 *   mkdtemp 出来的目录**天然是空的、天然是新的**，于是"清空"这个动作整个消失，
 *   并发跑批也不会互相踩（各拿各的随机后缀）。
 */
export function createEvalRunRoot(runsBase: string, runId: string): string {
  mkdirSync(runsBase, { recursive: true });
  const root = mkdtempSync(join(runsBase, `${EVAL_RUN_PREFIX}${runId}-`));
  writeFileSync(join(root, EVAL_ROOT_MARKER), `${runId}\n`, 'utf8');
  return root;
}
