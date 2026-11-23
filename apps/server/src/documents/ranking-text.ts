/** 给向量与重排模型看的检索文本；引用与展示始终使用未改写的块原文。 */
export function rankingText(
  title: string,
  sectionPath: readonly string[],
  text: string,
): string {
  const labels = [title.trim(), ...sectionPath.map((item) => item.trim())]
    .filter((item) => item !== '' && !text.startsWith(item));
  const unique = [...new Set(labels)];
  const heading = unique.join(' › ').slice(0, 180);
  return heading === '' ? text : `${heading}\n${text}`;
}
