export function ResolutionCostNote({ size, className }: { size: string; className: string }) {
  return size === "4K" ? <p className={className}>4K 出图更慢，费用更贵。</p> : null;
}
