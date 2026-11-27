export function BrandLogo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return <img src="/logo.svg" alt="" width={size} height={size} className={className} />;
}
