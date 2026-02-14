"use client";

import { memo, useEffect, useRef, useState } from "react";

function HoverMarqueeTextInner({ text }: { text: string }) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const measure = () => {
      setIsOverflowing(element.scrollWidth > element.clientWidth + 2);
    };

    measure();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    window.addEventListener("resize", measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  return (
    <span
      ref={containerRef}
      className="block min-w-0 overflow-hidden whitespace-nowrap"
    >
      {isOverflowing ? (
        <span className="inline-flex min-w-max will-change-transform group-hover:animate-[kb-marquee_11s_linear_infinite]">
          <span>{text}</span>
          <span className="pl-8">{text}</span>
        </span>
      ) : (
        <span className="block truncate">{text}</span>
      )}
    </span>
  );
}

const HoverMarqueeText = memo(HoverMarqueeTextInner);
export default HoverMarqueeText;
