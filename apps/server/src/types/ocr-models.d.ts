/**
 * 给 `@gutenye/ocr-models` 补类型。
 *
 * 这个包只发布了一个 `node.js`（exports 里只有 "./node" 一个入口），
 * 既没有 `types` 字段也没有 `node.d.ts`，TypeScript 直接 import 会报
 * "找不到声明文件"。与其在调用处 `as any` 蒙过去，不如在这里补上用到的那一块 ——
 * 这三个路径是 OCR 能不能跑起来的前提：写错任意一个的表现是
 * 「识别不出任何文字」且不抛任何错，正是本项目最怕的那类静默失败，
 * 属于必须让类型盯住的东西。
 */
declare module '@gutenye/ocr-models/node' {
  const modelPaths: {
    /** 文本检测模型：找出图里哪些位置有文字 */
    detectionPath: string;
    /** 文本识别模型：把框里的字读出来 */
    recognitionPath: string;
    /** 识别用的字符表（PP-OCR 的 6623 字字典） */
    dictionaryPath: string;
  };
  export default modelPaths;
}
