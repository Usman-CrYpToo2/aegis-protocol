export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="12.5" stroke="#7E2A1E" strokeWidth="1.5" />
      <circle cx="14" cy="14" r="8.5" stroke="#7E2A1E" strokeWidth="1" />
      <path d="M10 14.2l2.6 2.6L18.2 11" stroke="#7E2A1E" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
