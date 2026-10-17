// The quality report a repair attempt reads (BF-041): the issues the gate found, stored next to the attempt's spec.

/** Issues a repair attempt is given (the most severe first, as the pipeline orders them). */
export const MAX_REPORTED_ISSUES = 100;

/** Where an attempt's quality report is kept for the repair that follows it. */
export const qualityReportKey = (organizationId: string, jobId: string, attemptNo: number) =>
  `generation/${organizationId}/${jobId}/${attemptNo}/quality.json`;
