/*
 * formfillm — central debug flags
 *
 * Fine-grained, per-channel debug logging. Every flag defaults to OFF; flip an
 * individual one to enable just that category of console output. These flags
 * control console logging ONLY — none of them enables any network egress or
 * changes behavior, so they are safe to ship as false.
 *
 * Used across the background worker, content script, and side panel (all
 * bundled, so this single source of truth is shared everywhere).
 */

export const DEBUG = {
  /** Network connection to local Ollama: requests, responses, timing, aborts,
   *  and the classification / password-policy calls that drive them. */
  ollamaNetwork: false,

  /** Action gesture, content-script injection, and message routing. */
  messaging: false,

  /** Field filling inside the content script (page console). */
  fill: false,

  /** Side panel actions (side panel console). */
  panel: false,
} as const;

export type DebugChannel = keyof typeof DEBUG;

/** Log under a channel; emits only when that channel's flag is enabled. */
export function debugLog(channel: DebugChannel, ...args: unknown[]): void {
  if (DEBUG[channel]) {
    console.log(`[formfillm:${channel}]`, ...args);
  }
}
