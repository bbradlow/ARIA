/**
 * Split text into ~maxChars chunks on paragraph boundaries, carrying a small
 * tail of the previous chunk forward as overlap so context isn't lost at the
 * seams. ~3000 chars is roughly 600-750 tokens per chunk.
 */
export function chunkText(text: string, maxChars = 3000, overlapChars = 300): string[] {
  const clean = (text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current.trim());
      const tail = current.slice(-overlapChars);
      current = `${tail}\n\n${para}`;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
    // A single paragraph longer than maxChars: hard-split it.
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars).trim());
      current = current.slice(maxChars - overlapChars);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
