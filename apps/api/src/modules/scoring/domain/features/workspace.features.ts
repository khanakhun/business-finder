import { daysSince, type FeatureComputes } from './feature.ts';

// Workspace features (BF-024 CRM): the workspace's own relationship with the business.

export const workspaceFeatures: FeatureComputes = {
  do_not_contact: (facts) => facts.workspace.doNotContact,
  pipeline_status: (facts) => facts.workspace.pipelineStatus,
  days_since_last_contact: (facts) =>
    facts.workspace.lastContactedAt === null ? null : daysSince(facts, facts.workspace.lastContactedAt),
};
