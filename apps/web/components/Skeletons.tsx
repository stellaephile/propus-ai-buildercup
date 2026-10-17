"use client";

/**
 * Shaped skeletons (§6c.1): the `plan` SSE event announces the result kinds,
 * and skeletons *shaped like those kinds* render in their final positions in
 * < 300 ms. Skeleton → content is a crossfade, never a layout jump.
 */

import { motion, useReducedMotion } from "framer-motion";
import { forwardRef } from "react";
import type { ResultKind } from "@propus/contract";
import { motionTokens } from "@/lib/tokens";

function Shimmer({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={`rounded bg-border/60 ${className ?? ""}`}
      animate={reduced ? undefined : { opacity: [0.5, 0.9, 0.5] }}
      transition={reduced ? undefined : { duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      aria-hidden
    />
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      <Shimmer className="h-3 w-2/3" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex gap-2">
          <Shimmer className="h-3 flex-[2]" />
          <Shimmer className="h-3 flex-1" />
          <Shimmer className="h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

function StatCardsSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2 p-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Shimmer className="h-7 w-16" />
          <Shimmer className="h-2.5 w-full" />
        </div>
      ))}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex items-end gap-2 h-32 p-4">
      {[0.9, 0.75, 0.7, 0.55, 0.5, 0.4, 0.35, 0.3].map((h, i) => (
        <Shimmer key={i} className="flex-1" />
      ))}
    </div>
  );
}

function MapLayerSkeleton() {
  return (
    <div className="p-4 flex items-center gap-3">
      <Shimmer className="h-10 w-10 rounded-md" />
      <div className="flex-1 space-y-2">
        <Shimmer className="h-3 w-1/2" />
        <Shimmer className="h-2.5 w-1/3" />
      </div>
    </div>
  );
}

function ComparisonSkeleton() {
  return (
    <div className="p-4 space-y-2">
      <div className="flex justify-between">
        <Shimmer className="h-4 w-24" />
        <Shimmer className="h-4 w-24" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex gap-2">
          <Shimmer className="h-3 flex-1" />
          <Shimmer className="h-3 w-16" />
          <Shimmer className="h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

const byKind: Record<ResultKind, () => JSX.Element> = {
  data_table: TableSkeleton,
  stat_cards: StatCardsSkeleton,
  bar_chart: ChartSkeleton,
  line_chart: ChartSkeleton,
  scatter_chart: ChartSkeleton,
  pivot_table: TableSkeleton,
  comparison: ComparisonSkeleton,
  map_layer: MapLayerSkeleton,
};

// forwardRef so framer-motion's <AnimatePresence mode="popLayout"> can measure
// this child; a plain function component triggers a "cannot be given refs" warning.
export const ResultSkeleton = forwardRef<HTMLDivElement, { kind: ResultKind }>(
  function ResultSkeleton({ kind }, ref) {
    const reduced = useReducedMotion();
    const Inner = byKind[kind];
    return (
      <motion.div
        ref={ref}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0 }}
        transition={{ duration: motionTokens.dur.base }}
        className="rounded-lg bg-sheet"
      >
        <Inner />
      </motion.div>
    );
  }
);
