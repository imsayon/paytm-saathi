"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { animate, createTimeline, stagger, svg } from "animejs";

/** The motion layer steps aside when the visitor asked for less movement. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function revealNow(items: HTMLElement[], from = 18) {
  for (const item of items) item.setAttribute("data-revealed", "1");
  if (items.length === 0 || reducedMotion()) return null;
  return animate(items, {
    opacity: [0, 1],
    translateY: [from, 0],
    duration: 640,
    delay: stagger(60, { start: 30 }),
    ease: "outQuint",
  });
}

/**
 * Reveals `[data-reveal]` descendants as they enter the viewport, staggered
 * per batch. Screens fetch their data client-side, so the observer is rebuilt
 * whenever `ready` or `key` changes and only touches elements it has not
 * revealed yet. A safety timer reveals anything still hidden after a while.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(ready: boolean, key: unknown = null) {
  const root = useRef<T>(null);

  useEffect(() => {
    const host = root.current;
    if (!ready || !host) return;
    const pending = new Set(Array.from(host.querySelectorAll<HTMLElement>("[data-reveal]:not([data-revealed])")));
    if (pending.size === 0) return;

    const animations: { cancel: () => void }[] = [];
    let batch: HTMLElement[] = [];
    let flush: number | null = null;
    const flushBatch = () => {
      flush = null;
      const items = batch;
      batch = [];
      const animation = revealNow(items);
      if (animation) animations.push(animation);
    };

    // Anything already on screen reveals right away; the observer only waits for the rest.
    const viewport = window.innerHeight || document.documentElement.clientHeight;
    const aboveFold = Array.from(pending).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top < viewport * 0.98 && rect.bottom > 0;
    });
    if (aboveFold.length > 0) {
      for (const el of aboveFold) pending.delete(el);
      const animation = revealNow(aboveFold);
      if (animation) animations.push(animation);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          if (!pending.has(el)) continue;
          pending.delete(el);
          observer.unobserve(el);
          batch.push(el);
        }
        if (batch.length > 0 && flush === null) flush = window.setTimeout(flushBatch, 30);
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const el of pending) observer.observe(el);

    const safety = window.setTimeout(() => {
      const rest = Array.from(pending);
      pending.clear();
      const animation = revealNow(rest, 0);
      if (animation) animations.push(animation);
    }, 6000);

    return () => {
      observer.disconnect();
      window.clearTimeout(safety);
      if (flush !== null) window.clearTimeout(flush);
      for (const animation of animations) animation.cancel();
      for (const el of host.querySelectorAll<HTMLElement>("[data-revealed]")) {
        el.style.opacity = "";
        el.style.transform = "";
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
export function CountUp({ value, className, duration = 1000 }: { value: string | number; className?: string; duration?: number }) {
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

/** Headline whose characters rise into place one after another. */
export function SplitText({ text, accent, className }: { text: string; accent?: string; className?: string }) {
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const chars = Array.from(host.querySelectorAll<HTMLElement>(".ch"));
    if (chars.length === 0 || reducedMotion()) {
      chars.forEach((c) => (c.style.opacity = "1"));
      return;
    }
    const animation = animate(chars, {
      opacity: [0, 1],
      translateY: ["0.6em", "0em"],
      rotate: [6, 0],
      duration: 700,
      delay: stagger(18),
      ease: "outExpo",
    });
    return () => {
      animation.cancel();
      chars.forEach((c) => {
        c.style.opacity = "";
        c.style.transform = "";
      });
    };
  }, [text, accent]);

  // Words stay unbreakable inside their span; the separator is an ordinary
  // space text node so the accessible name reads naturally.
  const render = (value: string, extra?: string) =>
    value.split(" ").flatMap((word, wi, words) => [
      <span key={`${extra ?? "b"}-${wi}`} className={`word ${extra ?? ""}`}>
        {Array.from(word).map((ch, ci) => (
          <span key={ci} className="ch" style={{ opacity: 0 }}>
            {ch}
          </span>
        ))}
      </span>,
      wi < words.length - 1 ? " " : null,
    ]);

  return (
    <span ref={root} className={className} aria-label={[text, accent].filter(Boolean).join(" ")}>
      {render(text)}
      {accent ? (
        <>
          {" "}
          {render(accent, "accent")}
        </>
      ) : null}
    </span>
  );
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
    const animation = animate(el, { width: ["0%", width], duration: 1100, ease: "outQuart", delay: 160 });
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

/** Cursor-tracked glow border and a gentle 3D tilt. Pure CSS variables, no re-render. */
export function TiltCard({ children, className, style, ...rest }: { children: ReactNode; className?: string; style?: CSSProperties; [key: string]: unknown }) {
  const ref = useRef<HTMLDivElement>(null);

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
    el.style.setProperty("--ry", `${((x - 0.5) * 6).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${((0.5 - y) * 6).toFixed(2)}deg`);
  }

  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }

  return (
    <div ref={ref} className={`tilt ${className ?? ""}`} style={style} onMouseMove={onMove} onMouseLeave={onLeave} {...rest}>
      {children}
    </div>
  );
}

/** Endless ticker of short statements; hover pauses it. */
export function Marquee({ items }: { items: string[] }) {
  const doubled = [...items, ...items];
  return (
    <div className="marquee" aria-label={items.join(". ")}>
      <div className="track">
        {doubled.map((item, index) => (
          <span key={index} aria-hidden={index >= items.length}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Many signals, one approved action: a field of dots that funnels into a
 * single beam. Canvas, requestAnimationFrame, and nothing else. The cursor
 * pushes nearby dots away.
 */
export function ParticleField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const still = reducedMotion();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let frame = 0;
    const pointer = { x: -9999, y: -9999 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };
    const parent = canvas.parentElement ?? canvas;
    parent.addEventListener("pointermove", onMove);
    parent.addEventListener("pointerleave", onLeave);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const cols = 34;
    const rows = 22;
    const theme = () => document.documentElement.dataset.theme === "light";

    const draw = (t: number) => {
      context.clearRect(0, 0, width, height);
      const light = theme();
      const time = still ? 0 : t / 1000;
      const funnelEnd = width * 0.78;
      const cy = height / 2;
      for (let c = 0; c < cols; c += 1) {
        const fx = c / (cols - 1);
        const x = 24 + fx * (funnelEnd - 24);
        const squeeze = Math.pow(1 - fx, 1.35);
        const spread = (height * 0.46) * squeeze + 2;
        for (let r = 0; r < rows; r += 1) {
          const fy = r / (rows - 1) - 0.5;
          const wave = Math.sin(time * 1.4 + fx * 6 + r * 0.35) * 6 * squeeze;
          let px = x + Math.sin(time * 0.9 + r * 0.7) * 3 * squeeze;
          let py = cy + fy * spread * 2 + wave;
          const dx = px - pointer.x;
          const dy = py - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 90) {
            const push = (90 - dist) / 90;
            px += (dx / (dist || 1)) * push * 18;
            py += (dy / (dist || 1)) * push * 18;
          }
          const alpha = 0.22 + 0.6 * (1 - Math.abs(fy) * 1.2) * (0.5 + 0.5 * fx) + Math.sin(time * 2 + c * 0.5 + r) * 0.08;
          const radius = 1.1 + fx * 1.3;
          context.beginPath();
          context.arc(px, py, radius, 0, Math.PI * 2);
          context.fillStyle = light ? `rgba(28, 79, 216, ${Math.max(0.08, alpha * 0.7)})` : `rgba(120, 205, 255, ${Math.max(0.06, alpha)})`;
          context.fill();
        }
      }
      // The beam: everything the funnel produces, as one line.
      const gradient = context.createLinearGradient(funnelEnd - 20, 0, width, 0);
      gradient.addColorStop(0, light ? "rgba(28, 79, 216, 0.9)" : "rgba(56, 198, 255, 0.95)");
      gradient.addColorStop(1, "rgba(56, 198, 255, 0)");
      context.strokeStyle = gradient;
      context.lineWidth = 2.2;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(funnelEnd - 20, cy);
      context.lineTo(width, cy);
      context.stroke();
      const head = funnelEnd - 20 + ((time * 120) % (width - funnelEnd + 20));
      context.beginPath();
      context.arc(head, cy, 3.2, 0, Math.PI * 2);
      context.fillStyle = light ? "rgba(28, 79, 216, 1)" : "rgba(255, 255, 255, 0.95)";
      context.shadowColor = "rgba(56, 198, 255, 0.9)";
      context.shadowBlur = 14;
      context.fill();
      context.shadowBlur = 0;
      if (!still) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

export type RailStage = { key: string; title: string; detail: string; glyph: ReactNode; gate?: boolean };

/**
 * The workflow as a rail: the track draws itself, the stages pop in, and a
 * pulse keeps travelling along it. The gate node is dashed amber because
 * approval is the one step a human, not the system, takes.
 */
export function Rail({ stages }: { stages: RailStage[] }) {
  const root = useRef<HTMLDivElement>(null);
  const width = 1000;
  const height = 210;
  const left = 60;
  const right = width - 60;
  const step = (right - left) / (stages.length - 1);
  const y = (index: number) => 78 + (index % 2 === 0 ? 0 : 28);
  const path = stages
    .map((_, index) => {
      const x = left + step * index;
      if (index === 0) return `M ${x} ${y(0)}`;
      const px = left + step * (index - 1);
      const mid = (px + x) / 2;
      return `C ${mid} ${y(index - 1)}, ${mid} ${y(index)}, ${x} ${y(index)}`;
    })
    .join(" ");

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const lit = host.querySelector<SVGPathElement>(".track.lit");
    const pulse = host.querySelector<SVGCircleElement>(".pulse");
    const nodes = Array.from(host.querySelectorAll<SVGGElement>(".stage"));
    if (!lit || !pulse) return;
    if (reducedMotion()) {
      nodes.forEach((n) => (n.style.opacity = "1"));
      return;
    }
    const timeline = createTimeline();
    timeline.add(svg.createDrawable(lit), { draw: ["0 0", "0 1"], duration: 1600, ease: "inOutSine" }, 0);
    timeline.add(nodes, { opacity: [0, 1], scale: [0.7, 1], duration: 500, delay: stagger(140), ease: "outBack" }, 200);
    const { translateX, translateY } = svg.createMotionPath(lit);
    const ride = animate(pulse, { translateX, translateY, duration: 5200, loop: true, ease: "inOutSine", delay: 1200 });
    return () => {
      timeline.cancel();
      ride.cancel();
    };
  }, [stages.length]);

  return (
    <div ref={root} className="rail" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id="railGradient" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#4f8cff" />
            <stop offset="0.6" stopColor="#38c6ff" />
            <stop offset="1" stopColor="#ffb04a" />
          </linearGradient>
        </defs>
        <path className="track" d={path} />
        <path className="track lit" d={path} />
        <circle className="pulse" r="5" cx="0" cy="0" />
        {stages.map((stage, index) => {
          const x = left + step * index;
          const cy = y(index);
          return (
            <g key={stage.key} className="stage" style={{ opacity: 0, transformOrigin: `${x}px ${cy}px` }}>
              <circle className={`node ${stage.gate ? "gate" : ""}`} cx={x} cy={cy} r="20" />
              <g className="glyph" transform={`translate(${x - 8}, ${cy - 8}) scale(0.68)`}>
                {stage.glyph}
              </g>
              <text className="idx" x={x} y={cy - 32} textAnchor="middle">
                {String(index + 1).padStart(2, "0")}
              </text>
              <text className="label" x={x} y={cy + 44} textAnchor="middle">
                {stage.title}
              </text>
              <text className="sub" x={x} y={cy + 60} textAnchor="middle">
                {stage.detail}
              </text>
            </g>
          );
        })}
      </svg>
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

/** Horizontal strip fallback for small screens: stages light up in turn. */
export function Pipeline({ stages, className }: { stages: PipelineStage[]; className?: string }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const nodes = Array.from(host.querySelectorAll<HTMLElement>(".node"));
    if (nodes.length === 0) return;
    if (reducedMotion()) {
      nodes.forEach((node) => (node.style.opacity = "1"));
      return;
    }
    const entrance = animate(nodes, { opacity: [0, 1], translateY: [10, 0], duration: 480, delay: stagger(70), ease: "outBack" });
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
  }, [stages.length]);

  return (
    <div ref={root} className={`pipeline ${className ?? ""}`} aria-label="Workflow stages">
      {stages.map((stage) => (
        <div key={stage.key} className={`node${stage.gate ? " gate" : ""}`} style={{ opacity: 0 }}>
          <div className="glyph">{stage.icon}</div>
          <strong>{stage.title}</strong>
          <span>{stage.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Pops a set of elements in sequence with a small 3D flip; used for job chips after a delivery run. */
export function popIn(elements: HTMLElement[], delayMs = 40) {
  if (elements.length === 0 || reducedMotion()) return null;
  const timeline = createTimeline({ defaults: { ease: "outBack", duration: 520 } });
  timeline.add(elements, { rotateX: [-70, 0], scale: [0.86, 1], opacity: [0.3, 1], delay: stagger(delayMs) });
  return timeline;
}
