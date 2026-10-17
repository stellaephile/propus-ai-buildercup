"use client";

/**
 * The query input — one component for landing and app, shared layoutId so the
 * zero-cut entry morphs it (§6d). On the landing it cycles ghost text typing
 * the headline queries (permitted ambient motion on the landing ONLY;
 * reduced-motion shows static ghost text).
 */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { HEADLINE_QUERIES } from "@/lib/demo/queries";
import { motionTokens } from "@/lib/tokens";

export function QueryInput({
  onSubmit,
  ghost = false,
  autoFocus = false,
  disabled = false,
  onStop,
}: {
  onSubmit: (q: string) => void;
  ghost?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  /** when set and `disabled` (an answer is running), the Analyse button becomes Stop */
  onStop?: () => void;
}) {
  const reduced = useReducedMotion();
  const [value, setValue] = useState("");
  const [ghostText, setGhostText] = useState(ghost ? HEADLINE_QUERIES[0] : "");
  const inputRef = useRef<HTMLInputElement>(null);
  // which headline query the ghost text is typing, so an empty Enter submits all of it
  const ghostIndex = useRef(0);

  // cycling ghost typewriter — landing only, never while the user has typed
  useEffect(() => {
    if (!ghost || reduced) return;
    let qi = 0;
    let ci = 0;
    let deleting = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const q = HEADLINE_QUERIES[qi % HEADLINE_QUERIES.length];
      ghostIndex.current = qi % HEADLINE_QUERIES.length;
      if (!deleting) {
        ci++;
        setGhostText(q.slice(0, ci));
        if (ci >= q.length) {
          deleting = true;
          t = setTimeout(tick, 2200);
          return;
        }
        t = setTimeout(tick, 34);
      } else {
        ci = 0;
        deleting = false;
        qi++;
        setGhostText("");
        t = setTimeout(tick, 350);
      }
    };
    t = setTimeout(tick, 600);
    return () => clearTimeout(t);
  }, [ghost, reduced]);

  const submit = () => {
    const q = value.trim() || (ghost ? HEADLINE_QUERIES[ghostIndex.current] : "");
    if (q) onSubmit(q);
    setValue("");
  };

  return (
    <motion.div
      layoutId="propus-query-input"
      transition={reduced ? { duration: 0 } : motionTokens.spring}
      className="relative flex items-center gap-2 rounded-sm bg-vellumDeep px-3 py-2 w-full"
    >
      <span className="font-mono text-primary text-sm" aria-hidden>
        ▸
      </span>
      <div className="relative flex-1">
        {ghost && value === "" && (
          <span
            className="pointer-events-none absolute inset-0 flex items-center text-inkFaint text-[15px] truncate"
            aria-hidden
          >
            {reduced ? HEADLINE_QUERIES[0] : ghostText}
            {!reduced && <span className="ghost-caret ml-0.5">|</span>}
          </span>
        )}
        <input
          ref={inputRef}
          id="propus-query"
          maxLength={500}
          type="text"
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          aria-label="Ask the city a question"
          placeholder={ghost ? "" : "Ask a new question…"}
          className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-inkFaint"
        />
      </div>
      {disabled && onStop ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop the answer"
          className="shrink-0 rounded-md border border-celestial text-celestial text-sm font-medium px-3.5 min-h-[36px] transition-colors hover:bg-vellumShade"
        >
          Stop
        </button>
      ) : (
      <motion.button
        whileTap={reduced ? undefined : { scale: 0.98 }}
        transition={motionTokens.spring}
        onClick={submit}
        disabled={disabled}
        className="shrink-0 rounded-md bg-celestial text-onCelestial text-sm font-medium px-3.5 min-h-[36px] transition-colors hover:bg-primaryInk disabled:opacity-50 disabled:hover:bg-celestial"
      >
        Analyse
      </motion.button>
      )}
    </motion.div>
  );
}
