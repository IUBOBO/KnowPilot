type FileKind = 'pdf' | 'docx' | 'md' | 'txt';

const FILE_KINDS: readonly FileKind[] = ['pdf', 'docx', 'md', 'txt'];

/** Only mark formats the knowledge base actually accepts. */
export function FileTypeIcon({ fileName, title }: { fileName: string | null; title: string }) {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName ?? title)?.[1]?.toLowerCase();
  if (extension === undefined || !FILE_KINDS.includes(extension as FileKind)) return null;
  const kind = extension as FileKind;
  return (
    <span
      className={`file-type-icon file-type-${kind}`}
      role="img"
      aria-label={`${kind.toUpperCase()} 文件`}
      title={`${kind.toUpperCase()} 文件`}
    />
  );
}
