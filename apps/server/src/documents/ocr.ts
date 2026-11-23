/**
 * OCR：把「没有文字层的页」变成文字（决策 6）。
 *
 * 【这是什么问题】扫描件、拍照件、以及很多"另存为 PDF"的图片版文档，
 * 页面上只有像素、没有文字。pdfjs 对这类文件**不报错**，只是安静地返回空字符串，
 * 于是表现成"上传成功、状态就绪、一条都搜不到"。这是本项目最危险的一类失败。
 *
 * 【选型：@gutenye/ocr-node（PaddleOCR 的 PP-OCRv4 模型 + onnxruntime）】
 *   决策 6 定的是 PaddleOCR，并留了一条"RapidOCR 可免 Python"的备选。
 *   这个包正好同时满足两点：跑的就是 PaddleOCR 的官方 PP-OCRv4 权重，
 *   而执行靠 onnxruntime-node —— 与本项目 BGE-M3 用的是同一个运行时，
 *   **不引入 Python，也不引入第二个推理框架**。
 *   权重随包发布（16 MB），装完即可完全离线，不需要再写下载脚本。
 *
 * 【为什么不用 @gutenye/ocr-browser 那条路】
 *   浏览器版要在前端加载模型再上传识别结果，等于把"入库"这件事拆到两个进程里，
 *   而且模型要经网络送到每个访客的浏览器。识别必须留在服务端。
 */
import { existsSync } from 'node:fs';
import Ocr from '@gutenye/ocr-node';
import modelPaths from '@gutenye/ocr-models/node';
import { AppError } from '@knowpilot/shared';

/** 一行识别结果。坐标是像素，原点在左上角。 */
export interface OcrLine {
  text: string;
  /** 识别置信度 0–1。整行的平均值 */
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrPageResult {
  lines: OcrLine[];
  /** 本页所有行的平均置信度；一行都没识别出来时为 0 */
  meanConfidence: number;
}

/**
 * 一页的平均置信度低于这个值就写一条警告。
 *
 * 0.75 是实测取的：正常印刷体中文页平均在 0.99 以上，
 * 而模糊、倾斜、带水印的页面会掉到 0.6–0.7。
 * 这里只警告、**不删行** —— 低置信度不等于错，删掉可能把唯一的内容来源也删了。
 */
export const OCR_LOW_CONFIDENCE = 0.75;

/**
 * OCR 引擎实例。模块级单例。
 *
 * 为什么缓存：`Ocr.create()` 要加载两个 ONNX 会话（检测 4.7 MB + 识别 10.8 MB），
 * 每页重建一次的话，加载时间会比识别本身还长。
 * 缓存的是 Promise 而不是实例 —— 并发调用时也只创建一次。
 */
let enginePromise: Promise<Ocr> | null = null;

/** 三个权重文件是否都在。缺一个都跑不起来。 */
export function ocrModelsPresent(): boolean {
  return (
    existsSync(modelPaths.detectionPath) &&
    existsSync(modelPaths.recognitionPath) &&
    existsSync(modelPaths.dictionaryPath)
  );
}

/**
 * 权重必须落在数据盘。
 *
 * 与 BGE-M3 同一条约束（决策 8）：模型缓存不许占系统盘。
 * 这里的权重是随 npm 包走的，所以这条检查的实际含义是
 * **整个项目不能装在 C 盘** —— 项目在 C 盘时，337 MB 的依赖会一起落在那里。
 * 启动时不检查（OCR 是可选的），只在真正要用 OCR 时检查，
 * 免得"只跑检索"的场景被一个用不到的东西卡住。
 */
export function assertOcrModelsOnDataDrive(): void {
  const systemDrive = (process.env['SystemDrive'] ?? 'C:').toLowerCase();
  for (const p of [modelPaths.detectionPath, modelPaths.recognitionPath]) {
    const lower = p.toLowerCase();
    if (lower.startsWith(`${systemDrive}\\`) || lower.startsWith(`${systemDrive}/`)) {
      throw new AppError(
        'internal',
        `OCR 模型落在了系统盘：${p}\n` +
          `模型随 npm 包发布，所以这条实际意味着项目目录在 C 盘。` +
          `请把项目放到数据盘（模型与依赖共约 340 MB）。`,
      );
    }
  }
}

/**
 * 识别一张图。
 *
 * 【为什么直接吃内存里的 RGBA，不落临时文件】
 *   页面像素本来就在内存里（rasterize 的输出）。落成 PNG 再让 OCR 读回来，
 *   要多一次编码、一次解码、一次磁盘 IO，还要处理临时文件清理 ——
 *   而这条包对内存输入是一等公民（`ImageRawData`）。
 *
 * 【注意：这条路上确实会用到 sharp，而且它是个雷】
 *   一开始这里写的是"我们传内存数据，所以 sharp 不参与" —— **这是错的**。
 *   这个包内部对每一页都会构造 `sharp(data, { raw: { width, height, channels: 4 } })`
 *   （见 @gutenye/ocr-node 的 ImageRaw.ts），内存输入同样走 sharp，也就要走 libvips。
 *
 *   而 libvips 是个 C 库，靠 GObject 的类型系统注册属性。**同一个进程里只能有一份**：
 *   这个包要 sharp ^0.34.3、@huggingface/transformers 要 ^0.35.4，两个范围不相交，
 *   npm 只能在 OCR 包下再装一份；于是服务进程里同时存在两份 libvips，
 *   类型注册相互破坏，OCR **每一页**都抛 `colourspace: parameter space not set`。
 *   服务端一定同时加载两者（向量化用 transformers），所以这在真实服务里必现。
 *   修法在根 package.json 的 overrides 里（把 sharp 统一到 0.35.x），
 *   冒烟脚本里有一条断言专门守着"只能解析到一份 sharp"。
 *
 *   教训：依赖里有 sharp 不代表没开销，而"两份同名原生依赖"是查起来最费劲的一类问题 ——
 *   它在单模块的单元测试里完全不出现，只在真实进程的模块图凑齐时才复现。
 */
export async function recognizeImage(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<OcrPageResult> {
  if (!ocrModelsPresent()) {
    throw new AppError(
      'internal',
      `OCR 模型文件缺失，无法识别扫描页。请重新执行 npm install。`,
    );
  }
  assertOcrModelsOnDataDrive();

  const engine = await getEngine();
  // 这个包的 API 在类型上是 `Promise<any>`（它自己的 .d.ts 就写着 any），
  // 所以结果必须自己校验形状再使用 —— 不能因为"它是库返回的"就当它对。
  const raw: unknown = await engine.detect({ data, width, height });
  return normalize(raw);
}

function getEngine(): Promise<Ocr> {
  enginePromise ??= Ocr.create({
    // 显式给出三个路径，而不是用默认值：默认值藏在包的实现里，
    // 而出问题时（识别不出任何字）我们必须能一眼看出它到底加载的哪个文件。
    models: {
      detectionPath: modelPaths.detectionPath,
      recognitionPath: modelPaths.recognitionPath,
      dictionaryPath: modelPaths.dictionaryPath,
    },
  });
  return enginePromise;
}

/**
 * 校验并归一化库的返回值。
 *
 * 形状不对就抛错，而不是返回空数组 —— 空数组会被上层理解成
 * "这一页确实是空白"，于是静默地什么都不做。抛错至少能落到 warnings 里。
 */
function normalize(raw: unknown): OcrPageResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('internal', 'OCR 返回了非对象结果，无法解析。');
  }
  const texts = (raw as { texts?: unknown }).texts;
  if (!Array.isArray(texts)) {
    throw new AppError('internal', 'OCR 返回结果里没有 texts 数组，无法解析。');
  }

  const lines: OcrLine[] = [];
  for (const item of texts) {
    const line = toLine(item);
    if (line !== null) lines.push(line);
  }

  const meanConfidence =
    lines.length === 0 ? 0 : lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length;
  return { lines, meanConfidence };
}

function toLine(item: unknown): OcrLine | null {
  if (typeof item !== 'object' || item === null) return null;
  const { text, box, mean } = item as { text?: unknown; box?: unknown; mean?: unknown };
  if (typeof text !== 'string' || text.trim() === '') return null;
  if (!Array.isArray(box)) return null;

  const points: [number, number][] = [];
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = point[0];
    const y = point[1];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    points.push([x, y]);
  }
  if (points.length < 2) return null;

  // 取四点包围盒，而不是假定 box 一定是 [[左上],[右上],[右下],[左下]] ——
  // 检测模型对倾斜文字给出的是旋转后的四边形，按下标取会在倾斜页面上算错。
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    text: text.trim(),
    confidence: typeof mean === 'number' && Number.isFinite(mean) ? mean : 0,
    left,
    top,
    width: Math.max(...xs) - left,
    height: Math.max(...ys) - top,
  };
}
