export const WAIT_OBJECTS = {
  muiLinearProgress: 'div[class*="MuiLinearProgress-root"]',
  muiCircularProgress: '[class*="MuiCircularProgress-root"]',
} as const;

export const BULK_IMPORT_ACCORDION_LABEL =
  "Import to Red Hat Developer Hub" as const;

export const BULK_IMPORT_HEADING = "Bulk import" as const;

export const BULK_IMPORT_ROUTE = "/bulk-import" as const;

/** Status column labels after orchestrator workflow starts (not exhaustive). */
export const WORKFLOW_STATUS_LABELS = [
  "Pending",
  "Active",
  "Completed",
  "Aborted",
  "Error",
] as const;

export const LOGIN_REQUIRED_DIALOG_NAME = "Login Required" as const;
export const LOGIN_REQUIRED_LOG_IN_BUTTON = "Log in" as const;
export const LOGIN_REQUIRED_REJECT_ALL_BUTTON = "Reject All" as const;

export const REPO_STATUS_READY_TO_IMPORT = "Ready to import" as const;
export const REPO_STATUS_IMPORTED = "Imported" as const;
export const REPO_STATUS_WAIT_PR_APPROVAL = "WAIT_PR_APPROVAL" as const;
export const REPO_STATUS_ALREADY_IMPORTED = "Already imported" as const;

export const GITHUB_PROVIDER_LABEL = "GitHub" as const;
export const GITLAB_PROVIDER_LABEL = "GitLab" as const;
export const GITLAB_LOGIN_REJECTED_EMPTY_STATE =
  "Log in to view projects" as const;
export const NO_REPOSITORIES_FOUND_TEST_ID = "no-repositories-found" as const;

/** Footer action bar — avoids strict-mode clash with accordion "Import to Red Hat Developer Hub". */
export const ADD_REPOSITORY_FOOTER_TEST_ID = "add-repository-footer" as const;

/** Shown in Status column after orchestrator import starts (WORKFLOW_* + workflowId). */
export const VIEW_WORKFLOW_LINK_TEST_ID = "view-workflow-link" as const;
export const VIEW_WORKFLOW_LINK_LABEL = "View workflow" as const;
