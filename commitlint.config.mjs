// Conventional Commits + ticket reference (docs/conventions/git-workflow.md).
// Code-changing types must name their ticket, e.g. `feat(repo): bootstrap (BF-001)`;
// chores/docs/ci are nudged (warning) but not blocked.

const TICKET_REF = /\(BF-\d{3}\)/;
const REQUIRED_TYPES = ['feat', 'fix', 'refactor', 'perf'];
const RECOMMENDED_TYPES = ['chore', 'docs', 'ci'];

/** @param {string[]} types */
const ticketRefRule = (types) => (parsed) => {
  if (!parsed.type || !types.includes(parsed.type)) return [true];
  return [
    TICKET_REF.test(parsed.subject ?? ''),
    `subject must reference a ticket like "(BF-001)" for ${parsed.type} commits`,
  ];
};

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'bf/ticket-ref-required': ticketRefRule(REQUIRED_TYPES),
        'bf/ticket-ref-recommended': ticketRefRule(RECOMMENDED_TYPES),
      },
    },
  ],
  rules: {
    'bf/ticket-ref-required': [2, 'always'],
    'bf/ticket-ref-recommended': [1, 'always'],
  },
};
