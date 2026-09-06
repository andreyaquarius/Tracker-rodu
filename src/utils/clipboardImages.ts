type ClipboardImageData = {
  items: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>;
  files: ArrayLike<File>;
};

type ReadableClipboardItem = Pick<ClipboardItem, "types" | "getType">;

const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
};

function screenshotFile(blob: Blob, index: number, now: Date): File {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const extension = imageExtensions[blob.type.toLowerCase()] ?? "img";
  return new File([blob], `screenshot-${timestamp}-${index + 1}.${extension}`, {
    type: blob.type,
    lastModified: now.getTime(),
  });
}

/** Read only image bytes, never HTML, URLs, or ordinary pasted text. */
export function clipboardImageFiles(data: ClipboardImageData | null, now = new Date()): File[] {
  if (!data) return [];
  const items = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  // Browsers may expose the same image in both collections. Use files only as
  // a fallback, otherwise one paste would upload the screenshot twice.
  const images = items.length ? items : Array.from(data.files);
  return images
    .filter((file) => file.type.toLowerCase().startsWith("image/"))
    .map((file, index) => screenshotFile(file, index, now));
}

export function consumeClipboardImagePaste(
  event: Pick<ClipboardEvent, "defaultPrevented" | "preventDefault"> & { clipboardData: ClipboardImageData | null },
  onImages: (files: File[]) => void,
): boolean {
  if (event.defaultPrevented) return false;
  const files = clipboardImageFiles(event.clipboardData);
  if (!files.length) return false;
  event.preventDefault();
  onImages(files);
  return true;
}

/** Called only in response to the explicit Paste screenshot button. */
export async function readClipboardImageFiles(
  read: () => Promise<readonly ReadableClipboardItem[]>,
  now = new Date(),
): Promise<File[]> {
  const items = await read();
  const files: File[] = [];
  for (const item of items) {
    // One ClipboardItem can contain several representations of one image.
    const type = item.types.includes("image/png")
      ? "image/png"
      : item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    files.push(screenshotFile(blob, files.length, now));
  }
  return files;
}
