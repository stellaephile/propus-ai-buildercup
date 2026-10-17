"use client";

/**
 * Count-up numeral (§6b beat 5) — springSoft-driven, mono scale, snaps
 * instantly under reduced motion. Handles non-numeric values ("—", "N/A")
 * by rendering them verbatim: honesty beats animation.
 */

import { useEffect, useRef } from "react";
import {
  motion,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { motionTokens } from "@/lib/tokens";

export function CountUp({
  value,
  className,
  decimals,
}: {
  value: string;
  className?: string;
  decimals?: number;
}) {
  const reduced = useReducedMotion();
  const numeric = Number(value.replace(/[,+%]/g, ""));
  const isNumber = value.trim() !== "" && Number.isFinite(numeric);
  const dp = decimals ?? (value.includes(".") ? value.split(".")[1].length : 0);

  const spring = useSpring(0, {
    stiffness: motionTokens.springSoft.stiffness,
    damping: motionTokens.springSoft.damping,
  });
  const display = useTransform(spring, (v) =>
    v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })
  );
  const started = useRef(false);

  useEffect(() => {
    if (!isNumber) return;
    if (reduced) {
      spring.jump(numeric);
      return;
    }
    if (!started.current) {
      started.current = true;
      spring.set(numeric);
    } else {
      spring.set(numeric);
    }
  }, [numeric, isNumber, reduced, spring]);

  if (!isNumber) return <span className={className}>{value}</span>;

  const prefix = value.trim().startsWith("+") ? "+" : "";
  const suffix = value.trim().endsWith("%") ? "%" : "";
  return (
    <span className={className}>
      {prefix}
      <motion.span>{display}</motion.span>
      {suffix}
    </span>
  );
}
