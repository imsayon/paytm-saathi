"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { animate, createTimeline, stagger } from "animejs";

/** The motion layer steps aside when the visitor asked for less movement. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Staggers every `[data-reveal]` descendant into view the first time it
 * appears. Screens fetch their data client-side, so the hook runs again when
 * `ready` flips and only touches elements it has not revealed yet.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(ready: boolean, key: unknown = null) {
  const root = useRef<T>(null);

  useEffect(() => {
    const host = root.current;
    if (!ready || !host) return;
    const items = Array.from(host.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])"));
    if (items.length === 0) return;
    for (const item of items) item.setAttribute("data-revealed", "1");
    if (reducedMotion()) return;

    const animation = animate(items, {
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 560,
      delay: stagger(50, { start: 40 }),
      ease: "outQuint",
    });
    return () => {
      animation.cancel();
      for (const item of items) {
        item.style.opacity = "";
        item.style.transform = "";
      }
    };
  }, [ready, key]);

  return root;
}

export function Reveal({
  ready,
  refreshKey,
  children,
  className,
}: {
  ready: boolean;
  refreshKey?: unknown;
  children: ReactNode;
  className?: string;
}) {
  const root = useReveal<HTMLDivElement>(ready, refreshKey);
  return (
    <div ref={root} className={className}>
      {children}
    </div>
  );
}

const NUMERIC = /^([^\d-]*)(-?\d[\d,]*)(\.\d+)?(.*)$/;

function formatCounter(value: number, decimals: number, grouped: boolean): string {
  if (grouped) {
    return value.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  return value.toFixed(decimals);
}

/**
 * Counts a number up to its final text. React never renders children into the
 * span, so the DOM writes below cannot fight the reconciler; the final frame is
 * always the exact original string.
 */
export function CountUp({ value, className, duration = 900 }: { value: string | number; className?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = String(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const match = NUMERIC.exec(text);
    if (!match || reducedMotion()) {
      el.textContent = text;
      return;
    }
    const [, prefix = "", intPart = "0", decPart = "", suffix = ""] = match;
    const target = Number(`${intPart.replace(/,/g, "")}${decPart}`);
    const decimals = decPart ? decPart.length - 1 : 0;
    const grouped = intPart.includes(",");
    const counter = { v: 0 };
    el.textContent = `${prefix}${formatCounter(0, decimals, grouped)}${suffix}`;
    const animation = animate(counter, {
      v: target,
      duration,
      ease: "outExpo",
      onUpdate: () => {
        el.textContent = `${prefix}${formatCounter(counter.v, decimals, grouped)}${suffix}`;
      },
      onComplete: () => {
        el.textContent = text;
      },
    });
    return () => {
      animation.cancel();
      el.textContent = text;
    };
  }, [text, duration]);

  return <span ref={ref} className={className} aria-label={text} />;
}

/** A horizontal bar that grows to `fraction` of its track. */
export function AnimatedBar({ fraction, className }: { fraction: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = `${Math.max(Math.min(fraction, 1) * 100, fraction > 0 ? 2 : 0)}%`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) {
      el.style.width = width;
      return;
    }
    const animation = animate(el, { width: ["0%", width], duration: 900, ease: "outQuart", delay: 120 });
    return () => {
      animation.cancel();
    };
  }, [width]);

  return <div ref={ref} className={className} style={{ width: 0 }} />;
}

/** Campaign versus holdout as one split meter with a 2px surface gap. */
export function SplitMeter({ campaign, holdout }: { campaign: number; holdout: number }) {
  const total = campaign + holdout;
  const left = total === 0 ? 0 : campaign / total;
  const right = total === 0 ? 0 : holdout / total;
  return (
    <div className="split-meter" role="img" aria-label={`${campaign} in the campaign group, ${holdout} in the holdout`}>
      <AnimatedBar fraction={left} className="campaign" />
      <AnimatedBar fraction={right} className="holdout" />
    </div>
  );
}

export type PipelineStage = {
  key: string;
  title: string;
  detail: string;
  icon: ReactNode;
  gate?: boolean;
};

/**
 * The workflow strip. Each stage lights up in turn and the loop keeps rolling,
 * which reads as "one pipeline, in order" without a single word of prose.
 */
export function Pipeline({ stages, active }: { stages: PipelineStage[]; active?: string }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const nodes = Array.from(host.querySelectorAll<HTMLElement>(".node"));
    if (nodes.length === 0) return;

    if (reducedMotion()) {
      nodes.forEach((node) => node.classList.toggle("lit", node.dataset.key === active));
      return;
    }

    const entrance = animate(nodes, {
      opacity: [0, 1],
      translateY: [10, 0],
      scale: [0.96, 1],
      duration: 480,
      delay: stagger(70),
      ease: "outBack",
    });

    let index = 0;
    const light = () => {
      nodes.forEach((node, i) => node.classList.toggle("lit", i === index));
      index = (index + 1) % nodes.length;
    };
    const timer = window.setInterval(light, 1100);
    const first = window.setTimeout(light, 500);

    return () => {
      entrance.cancel();
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [stages.length, active]);

  return (
    <div ref={root} className="pipeline" aria-label="Workflow stages">
      {stages.map((stage) => (
        <div key={stage.key} data-key={stage.key} className={`node${stage.gate ? " gate" : ""}`} style={{ opacity: 0 }}>
          <div className="glyph">{stage.icon}</div>
          <strong>{stage.title}</strong>
          <span>{stage.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Pops a set of elements in sequence; used for job chips after a delivery run. */
export function popIn(elements: HTMLElement[], delayMs = 40) {
  if (elements.length === 0 || reducedMotion()) return null;
  const timeline = createTimeline({ defaults: { ease: "outBack", duration: 420 } });
  timeline.add(elements, { scale: [0.86, 1], opacity: [0.4, 1], delay: stagger(delayMs) });
  return timeline;
}
