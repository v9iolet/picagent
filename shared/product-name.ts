const sequencePrefix = /^(?:[0-9０-９]+(?:[.．](?![0-9０-９])|[、)）:]|$)|[（(][0-9０-９]+[)）])\s*/;
const label = /^(?:产品名称|商品名称|核心卖点|适用人群|期望场景|具体参数)\s*(?:[：:]\s*|$)/;

export function productNameFor(sellingPoints: unknown, firstOriginalFilename?: string): string {
  if (typeof sellingPoints === "string") {
    for (const line of sellingPoints.split(/\r?\n/)) {
      const value = line.trim().replace(sequencePrefix, "").replace(label, "").trim();
      if (value) return Array.from(value).slice(0, 30).join("");
    }
  }
  const filename = firstOriginalFilename?.trim() ?? "";
  const extension = filename.lastIndexOf(".");
  return (extension > 0 ? filename.slice(0, extension).trim() : filename) || "未命名商品套图";
}
