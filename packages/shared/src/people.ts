/**
 * 人员主档（投稿台账信息优化 · 第二步）。
 *
 * 【人员不是账号】人员是业务记录（姓名、学号、课题组、状态），账号是登录凭据。
 * 历史人员可以没有账号；一个账号也不应因为同名就自动认领某条人员记录。
 * 绑定由管理员确认，`user_id` 可空。
 *
 * 所有登录角色都持有 `people.read.sensitive`，可查看完整学号；接口仍按该权限
 * 返回字段，未授权的调用方收到 `null` 和 `studentNoVisible=false`。
 */

export const PERSON_STATUSES = ['active', 'graduated', 'left'] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const PERSON_STATUS_LABELS: Record<PersonStatus, string> = {
  active: '在册',
  graduated: '已毕业',
  left: '已离开',
};

export interface Person {
  id: string;
  name: string;
  /** 未授权时恒为 null；不能把 null 读成"没有学号"，看 `studentNoVisible`。 */
  studentNo: string | null;
  /** false = 当前调用方无权看这条学号。 */
  studentNoVisible: boolean;
  /** 从学号第 3、4 位派生；前四位不是数字时为 null。例：002400000001 → 24。 */
  grade: string | null;
  groupId: string | null;
  status: PersonStatus;
  /** 当前登录账号是否绑定到这条人员记录。 */
  isSelf: boolean;
  /** 绑定的登录账号；只有 `people.manage` 才拿得到，其他人为 null。 */
  linkedUserId: string | null;
  linkedUsername: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPeopleResponse {
  items: readonly Person[];
  /** 库里的总人数（不受搜索词影响）。 */
  total: number;
  /** 当前搜索词命中多少条（用于提示是否被 limit 截断）。 */
  matched: number;
}

export interface CreatePersonRequest {
  name: string;
  /** 文本保存，保留前导零；可留空。 */
  studentNo?: string;
  groupId?: string;
  status?: PersonStatus;
  /** 可选的登录账号绑定；必须由管理员确认。 */
  userId?: string;
}

export interface CreatePersonResponse {
  person: Person;
}

/**
 * 改一条人员记录。不出现的字段不动；`studentNo` / `groupId` / `userId`
 * 给 `null` 表示清空（解绑）。
 */
export interface UpdatePersonRequest {
  name?: string;
  studentNo?: string | null;
  groupId?: string | null;
  status?: PersonStatus;
  userId?: string | null;
  note?: string | null;
}

export interface UpdatePersonResponse {
  person: Person;
}
