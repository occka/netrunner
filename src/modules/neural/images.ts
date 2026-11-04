/** Photos for NEURAL: shrunk and re-encoded before they are stored or sent. */

const MAX_SIDE = 1568;
const QUALITY = 0.85;

export const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * Draws the image on a canvas and encodes a new JPEG: this drops all metadata,
 * including the location a phone stores in a photo. Returns base64 and the size.
 */
export async function encodePhoto(blob: Blob): Promise<{ data: string; bytes: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This image format cannot be read here. Use JPG, PNG, WebP, GIF or BMP.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not prepare the image");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encoded = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/jpeg", QUALITY),
  );
  const buffer = new Uint8Array(await encoded.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return { data: btoa(binary), bytes: buffer.length };
}
