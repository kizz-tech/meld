interface MeldMarkProps {
  size?: number;
  className?: string;
}

export default function MeldMark({ size = 16, className }: MeldMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="280 340 540 400"
      role="img"
      aria-label="meld"
      className={className}
    >
      <defs>
        <linearGradient id="meld-m-gold" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E8CA72" />
          <stop offset="100%" stopColor="#C4A54B" />
        </linearGradient>
        <linearGradient id="meld-m-gold-dark" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#C4A54B" />
          <stop offset="100%" stopColor="#8B7020" />
        </linearGradient>
      </defs>
      <g transform="translate(550, 550) skewX(-15) translate(-550, -550)">
        <path
          d="M 370,675 L 370,515 A 90 90 0 0 1 550 515 L 550,675"
          fill="none" stroke="url(#meld-m-gold)" strokeWidth="72" strokeLinecap="round"
        />
        <path
          d="M 730,675 L 730,515 A 90 90 0 0 0 550 515 L 550,675"
          fill="none" stroke="url(#meld-m-gold-dark)" strokeWidth="72" strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
