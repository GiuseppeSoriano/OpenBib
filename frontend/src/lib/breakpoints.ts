/*
 * Shared breakpoints. CSS cannot import these, so styles/tokens.css repeats
 * the queries literally — keep both in sync.
 */

/** Presentation switch: phones and short landscape screens (graph sheet vs. bar). */
export const COMPACT_QUERY = "(max-width: 639px), (max-height: 500px)";

/** Sizing switch: touch-sized controls (`--control-min` becomes `--touch-target`). */
export const TOUCH_QUERY = "(max-width: 639px), (pointer: coarse), (max-height: 500px)";

/** Widest viewport that shows the bottom tab bar. */
export const PHONE_MAX = 639;

/** Widest viewport where the details Panel is a bottom sheet. */
export const SHEET_MAX = 767;
