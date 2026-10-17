import type { QualityGateId, QualityIssue } from '@bf/contracts';

// Which issues go to a repair (BF-045): repairable errors first, in the gates' order (facts before copy before
// looks), then by severity, the same block's issues together, capped so an engine stays focused.

export const MAX_REPAIR_ISSUES = 12;

const GATE_ORDER: readonly QualityGateId[] = [
  'schema',
  'facts',
  'claims',
  'copy',
  'autofix',
  'a11y',
  'performance',
  'visual',
];
const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

export function prioritize(issues: readonly QualityIssue[], cap = MAX_REPAIR_ISSUES): QualityIssue[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (a, b) =>
        GATE_ORDER.indexOf(a.issue.gate) - GATE_ORDER.indexOf(b.issue.gate) ||
        SEVERITY[a.issue.severity] - SEVERITY[b.issue.severity] ||
        (a.issue.target?.blockId ?? '').localeCompare(b.issue.target?.blockId ?? '') ||
        a.index - b.index,
    )
    .slice(0, cap)
    .map(({ issue }) => issue);
}
