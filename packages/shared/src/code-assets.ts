/**
 * 数据集管理（需求 5 / 01 号 M-CODE）。
 *
 * 【命名】界面上这一块自 2026-10-07 起叫「数据集管理」：代码相关的那一半暂时
 * 搁置，先只做数据集。内部的表名与接口路径仍写作 `code_assets` /
 * `/api/v1/code-assets` —— 表名写在已发布的迁移 v10 里，改名要新开一条迁移，
 * 而这个字只在代码里出现，不值得为它多一次迁移。将来真做代码那一半，
 * 这份契约可以整个复用。
 *
 * 【这一类和文档的根本差别】文档进了库就是库里的东西，"文档在哪"没有意义；
 * 而代码与数据集永远留在文件系统上，库里存的只是**一个指路牌**。
 * 指路牌会失效 —— 目录被挪走、盘符掉线、那台机器关机。
 * 所以这一页要答的从来不是"有没有"，而是"**此刻还指得对不对**"。
 *
 * 【为什么结果不是布尔】设计文档 04 号 §4 给这张表定的是 `exists_flag`。
 * 那是个布尔，而布尔放不下这三件事的区别：
 *   存在     —— 探到了
 *   未找到   —— 探过了，确实没有
 *   无法核对 —— 本机根本看不到该去的地方（不在允许根目录内 / 在那台远程机器上）
 * 「未找到」与「无法核对」塌成同一个值时最危险：开发机上跑一次巡检，
 * 服务器上那几十个数据集会一起被报成"已失效"，而它们一个都没丢。
 * 所以这里刻意偏离文档，改成四态的结果枚举 —— 与 `usage_events` 的
 * 六个可空数值列同一个判断：**取不到就如实说取不到，不拿一个像样的值冒充**。
 */

/**
 * 核对结果。
 *
 * `unchecked` 是初始态：新登记的记录在被核对之前不该显示成任何一种结论。
 * 别把"还没看"当成"没找到"——巡检页上这两者差着一次排查。
 */
export const ASSET_CHECK_RESULTS = ['unchecked', 'exists', 'missing', 'unreachable'] as const;

export type AssetCheckResult = (typeof ASSET_CHECK_RESULTS)[number];

export const ASSET_CHECK_LABELS: Record<AssetCheckResult, string> = {
  unchecked: '未核对',
  exists: '存在',
  missing: '未找到',
  unreachable: '无法核对',
};

export const DATASET_PROFILE_LABELS = {
  purpose: '用途与研究任务', source: '来源', format: '数据格式', scale: '规模',
  labels: '字段与标签说明', version: '版本',
} as const;
export type DatasetProfile = Partial<Record<keyof typeof DATASET_PROFILE_LABELS, string>>;

export interface CodeAsset {
  id: string;
  /** 所属项目/课题。可空：不是每份数据都挂在一个课题下。 */
  project: string | null;
  name: string;
  /**
   * 它在哪：一个**绝对路径**。
   *
   * 【为什么必须绝对】相对路径的参照点只有进程的工作目录，而工作目录随启动
   * 方式变（见 config.ts 里 findRepoRoot 的注释）—— 同一个相对路径可能指两个
   * 地方，且两边都"看起来正常"，巡检还会给它一个误导性的理由（"不在允许根
   * 目录内"，而真正的问题是它压根不是个完整路径）。所以登记时就拒绝。
   * 注意 Linux 路径在 Windows 上也是"绝对"的（`isAbsolute('/hdd1/x')` 为真），
   * 因此在开发机上登记数据服务器上的路径不受影响 —— 这正需要，见 `host`。
   *
   * 【为什么不把地址写这儿】"在哪"和"怎么拿到"是两问（01 号 M-CODE）。
   * 地址写进 location 的话它永远探不了，会变成一条常年"无法核对"的记录 ——
   * 而"无法核对"是这页最需要用户当真的信号，拿它当噪音用，等真有数据丢了
   * 就没人看了。"怎么获取"写在 `accessNote` 里，那里什么写法都行。
   *
   * 登记时不校验它是否落在允许根目录内 —— 理由见 `check.ts` 顶部。
   */
  location: string;
  /**
   * 这份东西在哪台机器上。`null` = 就是**服务所在的这台机器**。
   *
   * 这一列不是装饰：它决定了本机该不该去探测。声明了主机的记录，
   * 本机**一律不探**（探了也只能得到"我这儿没有"，纯属误报）。
   */
  host: string | null;
  /** 「怎么获取」。01 号 M-CODE 要回答的两问之一，另一问是"在哪"。 */
  accessNote: string | null;
  notes: string | null;
  profile?: DatasetProfile;
  documentationId?: string | null;
  lastCheckResult: AssetCheckResult;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一个允许根目录**此刻**的样子。
 *
 * 把它单独返回给前端，是为了让「无法核对」这句结论当场就能被解释清楚：
 * 用户看到一整屏"无法核对"，第一反应是系统坏了；看到
 * 「根目录 /data 在本机看不到」就立刻明白是自己没部署在数据服务器上。
 * 这两句话的差别，就是这一页可不可信的差别。
 */
export interface AllowedRoot {
  path: string;
  /** 本机此刻能否看到这个目录 */
  visible: boolean;
}

export interface ListCodeAssetsResponse {
  items: readonly CodeAsset[];
  /** 配置的允许根目录 + 此刻可见性。空数组是合法值：表示本机一个数据根都没配。 */
  roots: readonly AllowedRoot[];
}

export interface CreateCodeAssetRequest {
  name: string;
  location: string;
  project?: string;
  host?: string;
  accessNote?: string;
  notes?: string;
  profile?: DatasetProfile;
  documentationId?: string;
}

export interface CreateCodeAssetResponse {
  asset: CodeAsset;
  /** 登记时顺手核对的那一次为什么是这个结果。理由见 CheckedAsset.reason。 */
  reason: string;
}

/**
 * 修改一条已登记的记录。
 *
 * 【为什么按"提到了哪些字段"判断，而不是按"值是不是空"】
 * 一次修改里，「这个字段我没动」和「我要把它清空」是两件不同的事。JSON 能区分
 * 不带 `project` 与 `"project": null`，却不能区分 `"project": ""` 与真的填了个
 * 空名字 —— 而后者又和"还没填项目"没有分别。所以：
 *
 *   字段不出现   → 保持原样
 *   null / 空串  → 清空
 *   有值         → 设为该值
 *
 * `name` 与 `location` **不可清空**（它们是这条记录的全部意义），传给它们 null
 * 是错误，不是"清空"。界面上的编辑表单会把六个字段原样回传，走界面时不会踩到
 * 这层区别；这层区别是给脚本和将来的客户端留的。
 */
export interface UpdateCodeAssetRequest {
  name?: string;
  location?: string;
  project?: string | null;
  host?: string | null;
  accessNote?: string | null;
  notes?: string | null;
  profile?: DatasetProfile | null;
  documentationId?: string | null;
}

export interface UpdateCodeAssetResponse {
  asset: CodeAsset;
  /**
   * 这次**顺带重新核对**了吗。`null` = 没重核。
   *
   * 只有改了 `location` 或 `host` 才重核：只改名称、项目、备注这些文字字段，
   * 存在性结论与改之前是同一件事（路径没变，没有理由推翻它）。
   * 而改了位置就一定重核 —— 旧结论说的是**另一个位置**，把它留在一条新路径上，
   * 就是让一条过期的判断冒充当前事实。
   */
  reason: string | null;
}

export interface DeleteCodeAssetResponse {
  /**
   * 删掉的是哪一条。回显给用户确认，也方便写进日志。
   *
   * ⚠️ 删的**只是这条登记记录**。`location` 指向的数据集一个字节都不会动 ——
   * 见 apps/server/src/code/repo.ts 里 deleteCodeAsset 的注释。
   */
  deleted: { id: string; name: string; location: string };
}

/**
 * 一条刚核对过的记录。
 *
 * 【为什么 reason 一定要跟着结果一起回给前端，却不入库】
 * 「无法核对」有至少三种成因，对应的动作完全不同：
 *   不在任何允许根目录内 → 改 .env 里的 CODE_ROOTS
 *   本机看不到这个根目录 → 这台机器上本来就没有，去数据服务器上看
 *   这条声明在别的机器上 → 正常，它就该由那台机器去核对
 * 只给一个"无法核对"，用户唯一能做的就是来问我们。
 *
 * 但它是**这台机器此刻**的判断（换个部署位置就变），存进库必然过期，
 * 而过期的原因会把用户指向一个已经不存在的问题。所以它随响应走，
 * 不落库 —— 与 `probeRoots` 现探现算同一个判断。
 */
export interface CheckedAsset {
  asset: CodeAsset;
  reason: string;
}

/** 单条核对（点某一行的「核对」）。 */
export interface CheckCodeAssetResponse {
  checked: CheckedAsset;
}

/** 批量核对（点「全部核对」）。 */
export interface CheckCodeAssetsResponse {
  /** 按结果分类的条数。整批"无法核对"时，这里一眼看得出来。 */
  summary: Record<AssetCheckResult, number>;
  items: readonly CheckedAsset[];
}
