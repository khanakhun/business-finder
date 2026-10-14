/** Brand mark: a lagoon tile crossed by two depth soundings, as on a nautical chart. Decorative. */
export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className}>
      <rect width="20" height="20" rx="5" fill="var(--lagoon)" />
      <path
        d="M4 8.5c2-1.6 4-1.6 6 0s4 1.6 6 0"
        fill="none"
        stroke="var(--lagoon-ink)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4 12.5c2-1.6 4-1.6 6 0s4 1.6 6 0"
        fill="none"
        stroke="var(--lagoon-ink)"
        strokeOpacity=".55"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
