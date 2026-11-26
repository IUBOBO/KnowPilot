// Generate complete ASCII PDFs so the fixture contains no external or private material.
const stream = (commands) => `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`;
function pdf(pageStreams, catalog = '', extraResources = '', extraObjects = []) {
  const resources = extraResources.startsWith('/Font') ? extraResources : '/Font << /F1 3 0 R >> ' + extraResources;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalog} >>`,
    `<< /Type /Pages /Kids [${pageStreams.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pageStreams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, commands] of pageStreams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${5 + i * 2} 0 R >>`,
      stream(commands),
    );
  }
  objects.push(...extraObjects);
  let body = '%PDF-1.7\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}

const line = (x, y, value, mode = 0) => `BT /F1 14 Tf ${mode} Tr 1 0 0 1 ${x} ${y} Tm (${value}) Tj ET`;
const raster = 'q 420 0 0 240 60 480 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID BBAADDCC> EI Q';
export const mainPdf = pdf([
  line(48, 724, 'Page one cover'),
  [
    line(48, 724, 'A unique elast-'),
    line(48, 706, 'icity result follows.'),
    line(48, 674, 'Repeated excerpt lives here.'),
    line(48, 640, 'Repeated excerpt appears again.'),
    line(48, 610, 'Office uses a standard text layer.'),
  ].join('\n'),
  [
    line(48, 724, 'Unrelated left evidence'),
    line(330, 724, 'Right evidence in the second column.'),
    line(48, 708, 'Next line in the left column.'),
    line(330, 708, 'Next line in the right column.'),
  ].join('\n'),
  raster,
  `${raster}\n${line(48, 724, 'Invisible OCR from the index.', 3)}`,
], '/PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 12 >>] >>');
export const otherPdf = pdf([line(48, 724, 'Second document with independent text')]);

export const layeredPdf = pdf([
  `/OC /Hidden BDC\n${line(48, 724, 'Default hidden selection')}\nEMC`,
  `/OC /Visible BDC\n${line(48, 724, 'Default visible selection')}\nEMC`,
], '/OCProperties << /OCGs [8 0 R 9 0 R] /D << /BaseState /ON /OFF [8 0 R] >> >>',
'/Properties << /Hidden 8 0 R /Visible 9 0 R >>', [
  '<< /Type /OCG /Name (Hidden text) >>',
  '<< /Type /OCG /Name (Visible text) >>',
]);

// Minimal embedded glyphs and ToUnicode map for the line-wrap test, independent of system fonts.
const cjkMap = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
  '/CMapName /SyntheticCJK def /CMapType 2 def',
  '1 begincodespacerange <00> <FF> endcodespacerange',
  '3 beginbfchar <41> <4E2D> <42> <6587> <43> <539F> endbfchar',
  'endcmap CMapName currentdict /CMap defineresource pop end end',
].join('\n');
const glyph = (paths) => stream(`900 0 0 0 900 900 d1 55 w ${paths} S`);
export const cjkPdf = pdf([
  'BT /CJ 14 Tf 1 0 0 1 48 724 Tm <4142> Tj 1 0 0 1 48 706 Tm <4342> Tj ET',
], '', '/Font << /F1 3 0 R /CJ 6 0 R >>', [
  '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 900 900] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /Zhong 8 0 R /Wen 9 0 R /Yuan 10 0 R >> /Encoding << /Type /Encoding /Differences [65 /Zhong /Wen /Yuan] >> /FirstChar 65 /LastChar 67 /Widths [900 900 900] /Resources << >> /ToUnicode 7 0 R >>',
  stream(cjkMap),
  glyph('100 350 700 300 re 450 100 m 450 850 l'),
  glyph('410 850 m 480 740 l 95 700 m 800 700 l 220 650 m 360 390 l 760 130 l 680 650 m 530 390 l 130 130 l'),
  glyph('140 100 m 215 390 l 215 800 l 820 800 l 360 410 365 220 re 565 730 m 530 630 l 565 410 m 565 130 l 490 130 l 420 340 m 310 160 l 690 335 m 820 155 l'),
]);
