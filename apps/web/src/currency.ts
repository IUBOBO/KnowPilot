/** 展示折算快照；原始调用流水继续按供应商的美元口径保存。
 * 中国银行 2026-10-21 中行折算价：每 100 美元对应 671.92 元。
 * 更新汇率时必须同时更新日期；此值不代表实时或历史结算汇率。
 */
export const USD_TO_CNY = 6.7192;
export const CNY_RATE_DATE = '2026-10-21';
export const CNY_RATE_SOURCE = 'https://www.bankofchina.com/sourcedb/whpj/index_9.html';
export const CNY_RATE_NOTE = `人民币参考金额，按 1 美元 = ${USD_TO_CNY} 元折算（${CNY_RATE_DATE} 中行折算价，非实时汇率）；实际结算以账单为准。`;

export function formatCnyFromUsd(usd: number): string {
  const cny = usd * USD_TO_CNY;
  if (cny > 0 && cny < 0.0001) return '< ¥0.0001';
  return `¥${cny.toLocaleString('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}
