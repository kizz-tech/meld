interface MeldLogoProps {
  size?: number;
  className?: string;
}

export default function MeldLogo({ size = 24, className }: MeldLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="137 137 826 826"
      role="img"
      aria-label="meld"
      className={className}
    >
      <defs>
        <radialGradient id="meld-bg" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor="#141210" />
          <stop offset="100%" stopColor="#0A0A0A" />
        </radialGradient>
        <radialGradient id="meld-sheen" cx="15%" cy="15%" r="60%">
          <stop offset="0%" stopColor="#E8CA72" stopOpacity={0.12} />
          <stop offset="100%" stopColor="#E8CA72" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="meld-glass" cx="50%" cy="0%" r="60%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.03} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="meld-gold" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E8CA72" />
          <stop offset="100%" stopColor="#C4A54B" />
        </linearGradient>
        <linearGradient id="meld-gold-dark" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#C4A54B" />
          <stop offset="100%" stopColor="#8B7020" />
        </linearGradient>
        <linearGradient id="meld-core-glow" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity={0.9} />
          <stop offset="35%" stopColor="#E8CA72" stopOpacity={0.6} />
          <stop offset="100%" stopColor="#C4A54B" stopOpacity={0} />
        </linearGradient>
      </defs>
      <rect x="140" y="140" width="820" height="820" rx="240" fill="url(#meld-bg)" />
      <rect x="140" y="140" width="820" height="820" rx="240" fill="url(#meld-sheen)" />
      <rect x="140" y="140" width="820" height="820" rx="240" fill="url(#meld-glass)" />
      <rect
        x="140" y="140" width="820" height="820" rx="240"
        fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2"
      />
      <g transform="translate(550, 550) skewX(-15) translate(-550, -550)">
        <g fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="72" strokeLinecap="round" transform="translate(6, 12)">
          <path d="M 370,675 L 370,515 A 90 90 0 0 1 550 515 L 550,675" />
          <path d="M 730,675 L 730,515 A 90 90 0 0 0 550 515 L 550,675" />
        </g>
        <path
          d="M 370,675 L 370,515 A 90 90 0 0 1 550 515 L 550,675"
          fill="none" stroke="url(#meld-gold)" strokeWidth="72" strokeLinecap="round" opacity={0.95}
        />
        <path
          d="M 730,675 L 730,515 A 90 90 0 0 0 550 515 L 550,675"
          fill="none" stroke="url(#meld-gold-dark)" strokeWidth="72" strokeLinecap="round" opacity={0.95}
        />
        <path
          d="M 550,515 L 550,675"
          fill="none" stroke="url(#meld-core-glow)" strokeWidth="72" strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
