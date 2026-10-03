/**
 * The Aegis mark: one coin in two equal halves, offset. One asset, two forms, held equal.
 * Built from two r21 circles 6 apart with a 4.5 gap (design canvas "Offset coin · V2").
 */
export function LogoMark({ size = 28, color = "#7E2A1E" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="6 6 52 52" aria-hidden="true">
      <path d="M8 29.75A21 21 0 0 1 50 29.75Z" fill={color} />
      <path d="M14 34.25A21 21 0 0 0 56 34.25Z" fill={color} />
    </svg>
  );
}
