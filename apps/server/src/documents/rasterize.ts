/**
 * PDF 页面 → 像素。这是 OCR 的前置步骤，和"提取文字"是两件不同的事。
 *
 * 【为什么单独一个模块，而不是塞进 extract.ts】
 *   它的变更原因是「图像质量」（倍率、白底、内存上限），
 *   而 extract.ts 的变更原因是「怎么从文字还原段落与标题」。
 *   混在一起，以后只想调 OCR 的清晰度却要改到解析逻辑里。
 *
 * 【硬约束：全仓库只能有一份 @napi-rs/canvas，且版本必须与 pdfjs 兼容】
 *   pdfjs 渲染时并不用我们给的画布 —— 它自己 `require('@napi-rs/canvas')`
 *   造临时画布，并亲手把**它解析到的那份** Path2D / DOMMatrix / ImageData
 *   挂到 globalThis 上（见 pdf.mjs 的 isNodeJS 分支与 polyfill 块），
 *   然后 `new Path2D()` 去构造路径。而路径最终喂给的是**我们**这份
 *   `createCanvas` 的 ctx。
 *
 *   于是只要树里存在两份原生模块，就会出现：pdfjs 用 A 份的 Path2D 造的路径，
 *   交给 B 份的 canvas —— napi 的类检查不认，抛
 *     `Value is none of these types `String`, `Path``
 *   栈指向 `CanvasGraphics.consumePath`（看着像 pdfjs 的 bug），
 *   而且**只在含裁剪或字形的页面上复现**，别的页好好的。
 *
 *   这个错在本项目真实发生过：apps/server 声明了 `^1.0.9` 而 pdfjs 的
 *   optionalDependency 是 `^0.1.80`，两个范围不相交 → npm 把 0.1.80 提升到根、
 *   把 1.0.9 装进 apps/server/node_modules。修法是让两处范围相容
 *   （apps/server 声明 `^0.1.80`），于是只剩下根上那一份。
 *   排查时吃过两次亏，所以把症状原样写在这里，方便日后搜到。
 *
 * 【顺带一个结论：不需要自己写画布工厂，也不需要接全局构造器】
 *   一开始这里手写过 NodeCanvasFactory 和 installCanvasGlobals()，
 *   理由是"Node 里没有 canvas"。实测是多余的（pdfjs 自带同名工厂并自动选用，
 *   Path2D 也由它自己接），那两份代码因此删掉了 —— 留着不是"保险"，
 *   而是两条各自演化的实现路径。注意：真正让渲染失败的从来不是缺全局构造器，
 *   而是上一条里的**两份模块**；当时误诊成前者，绕了一圈才定位到依赖树。
 */
import { createCanvas } from '@napi-rs/canvas';
import type { PDFPageProxy } from 'pdfjs-dist';

/**
 * 光栅化倍率。2 倍 = 144 DPI。
 *
 * 实测（真实中文公文，A4 单页，28 行）：
 *   1.5 倍 893×1263   识别 2010ms  平均置信度 0.9902
 *   2.0 倍 1191×1684  识别 1935ms  平均置信度 0.9963
 *   3.0 倍 1786×2526  识别 2529ms  平均置信度 0.9924
 * 2 倍既不是最慢也不是最差，置信度反而最高（1.5 倍是字太小丢了笔画，
 * 3 倍是模型把图先缩回去，白多花时间）。所以取 2。
 */
export const RENDER_SCALE = 2;

/**
 * 单页像素上限。
 *
 * 正常 A4 在 2 倍下是 1191×1684 ≈ 200 万像素。但 PDF 的页面尺寸没有上限，
 * 一整页排一张大图的扫描件能到几万像素宽 —— 那时 RGBA 缓冲会直接吃掉几个 GB。
 * 超过就按比例把倍率降下来：**宁可糊一点，不能把进程打死**。
 */
const MAX_PIXELS = 12_000_000;

/** 光栅化的结果。RGBA 行优先，交给 OCR 时不需要落任何临时文件。 */
export interface RasterizedPage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * 实际用的倍率。**调用方必须用它把像素坐标换回 PDF 坐标**。
   *
   * 大多数时候等于 RENDER_SCALE，但超大页会被 fitScale 压下来 ——
   * 那时若还按 RENDER_SCALE 换算，识别出的 y 会整体偏移（页面越高偏得越多），
   * 于是页眉页脚判定、段落连续性全错，而且错得不明显。所以让它显式返回。
   */
  scale: number;
}

/**
 * 能被渲染的一页：pdfjs 的 `PDFPageProxy` 里我们用到的那两个方法。
 *
 * 【为什么不自己写一个窄接口】一开始写的是
 *   `render(params: { canvasContext: unknown; canvas: unknown; viewport: unknown })`，
 * 想着"只依赖形状、不依赖 pdfjs，换渲染器不用改这里"。**类型检查直接不通过**：
 * pdfjs 的 `RenderParameters.viewport` 是 `PageViewport`，而 `unknown` 不是它的子类型，
 * 参数位置的方向要求恰好相反，于是 `PDFPageProxy` 赋值不过来。
 * 要么在调用处 as 一下（把真实约束藏起来），要么就照实引用它的类型 —— 选后者。
 *
 * 这个耦合不比原来更重：上面那段已经说明渲染本身依赖 pdfjs 的内部行为（它自带画布工厂），
 * 所以"换掉 pdfjs 只要改这个接口"本来就是假的。用它的公开参数类型反而更诚实。
 *
 * 参数写成 `Parameters<PDFPageProxy['...']>` 而不是直接引用 `RenderParameters` /
 * `GetViewportParameters`：这两个类型在 `types/src/pdf.d.ts` 里**没有 re-export**，
 * 只有 `api.d.ts` 里才有。直接 import 得写到 `pdfjs-dist/types/src/display/api`，
 * 那是个内部路径 —— 为了省一次类型推导去依赖内部目录结构，不划算。
 */
export type RenderablePage = Pick<PDFPageProxy, 'getViewport' | 'render'>;

/**
 * 把一页渲染成 RGBA 像素。
 *
 * 白底是必须的：画布默认是**全透明**的，而 OCR 读的是 RGB 三个通道 ——
 * 透明像素的 RGB 是 0（黑），黑字落在黑底上等于什么都没画。
 * 扫描件本身也是白底黑字，铺白底同时也更接近真实输入。
 */
export async function renderPageToRgba(
  page: RenderablePage,
  scale: number = RENDER_SCALE,
): Promise<RasterizedPage> {
  const base = page.getViewport({ scale: 1 });
  const effectiveScale = fitScale(base.width, base.height, scale);
  const viewport = page.getViewport({ scale: effectiveScale });

  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  await page.render({ canvasContext: context, canvas, viewport }).promise;

  const imageData = context.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height, scale: effectiveScale };
}

/**
 * 把倍率压到像素上限以内。
 *
 * 只在超限时才动倍率：正常页面必须用调用方指定的倍率，
 * 否则实测出来的那个"2 倍最准"就不成立了。
 */
function fitScale(baseWidth: number, baseHeight: number, wanted: number): number {
  const pixels = baseWidth * baseHeight * wanted * wanted;
  if (pixels <= MAX_PIXELS) return wanted;
  return Math.max(0.5, wanted * Math.sqrt(MAX_PIXELS / pixels));
}
