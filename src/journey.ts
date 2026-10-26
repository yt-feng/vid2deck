export type JourneyStage = 'source' | 'extract' | 'review' | 'export' | 'done';

export type JourneyInput = {
  hasSource: boolean;
  busy: boolean;
  frameCount: number;
  selectedCount: number;
  reviewed: boolean;
  exported: boolean;
};

/**
 * Derive the next useful step from the current task, including sample tasks.
 * Callers reset reviewed/exported when changing a task or its export contents;
 * exported means an export was generated, not that its file was saved to disk.
 */
export function getJourneyStage(input: JourneyInput): JourneyStage {
  // A new extraction can retain earlier frames until it succeeds. Never present
  // those frames as a completed result while another operation is in progress.
  if (input.busy) return 'extract';

  const hasFrames = Number.isSafeInteger(input.frameCount) && input.frameCount > 0;
  if (!hasFrames) return input.hasSource ? 'extract' : 'source';

  const hasSelection = Number.isSafeInteger(input.selectedCount)
    && input.selectedCount > 0 && input.selectedCount <= input.frameCount;
  if (!hasSelection) return 'review';

  // Experienced users can export directly without following the coach.
  if (input.exported) return 'done';
  return input.reviewed ? 'export' : 'review';
}
