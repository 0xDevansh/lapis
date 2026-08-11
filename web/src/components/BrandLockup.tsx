/**
 * Faceted lapis stone mark — colors from CSS variables so the brand tracks theme.
 * Transparent background (no fill behind the stone).
 */
interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 28, className = "" }: BrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      {/* Lit top / left facets */}
      <path
        d="M32 4 L48 14 L40 22 L24 18 Z"
        fill="var(--accent-soft)"
      />
      <path
        d="M24 18 L40 22 L36 36 L16 30 Z"
        fill="var(--accent)"
      />
      {/* Front face */}
      <path
        d="M40 22 L52 28 L48 46 L36 36 Z"
        fill="color-mix(in srgb, var(--accent) 78%, var(--accent-deep))"
      />
      <path
        d="M16 30 L36 36 L28 52 L10 42 Z"
        fill="color-mix(in srgb, var(--accent) 70%, black)"
      />
      {/* Right / bottom dark facets */}
      <path
        d="M52 28 L56 40 L48 46 Z"
        fill="var(--accent-deep)"
      />
      <path
        d="M36 36 L48 46 L40 56 L28 52 Z"
        fill="color-mix(in srgb, var(--accent-deep) 75%, black)"
      />
      <path
        d="M10 42 L28 52 L22 58 L8 48 Z"
        fill="color-mix(in srgb, var(--accent-deep) 90%, black)"
      />
      <path
        d="M48 46 L56 40 L50 54 L40 56 Z"
        fill="color-mix(in srgb, var(--accent-deep) 85%, black)"
      />
      {/* Pyrite gold vein — top → right → bottom tip */}
      <path
        d="M48 14 L40 22 L52 28 L48 46 L40 56 L28 52"
        stroke="var(--brand-gold)"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

interface BrandLockupProps {
  size?: number;
  className?: string;
  textClassName?: string;
  as?: "div" | "span";
}

export function BrandLockup({
  size = 28,
  className = "",
  textClassName = "text-xl font-bold tracking-wide text-ink",
  as: Tag = "div",
}: BrandLockupProps) {
  return (
    <Tag className={`inline-flex items-center gap-2 ${className}`}>
      <BrandMark size={size} />
      <span className={textClassName}>Lapis</span>
    </Tag>
  );
}
