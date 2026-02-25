import * as fs from "node:fs/promises";

/**
 * Read a PNG file and return it as a base64 string.
 */
export async function readPngAsBase64(pngPath: string): Promise<string> {
  const buffer = await fs.readFile(pngPath);
  return buffer.toString("base64");
}
