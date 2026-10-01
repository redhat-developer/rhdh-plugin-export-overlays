import type { Collector } from "../types";

export const DEFAULT_THRESHOLD_LABELS = ["Success", "Warning", "Error"];
export const DEFAULT_THRESHOLD_RULES = [
  { key: "success", color: "rgb(46, 125, 50)" },
  { key: "warning", color: "rgb(237, 108, 2)" },
  { key: "error", color: "rgb(211, 47, 47)" },
];

export const GITHUB_DEPLOYMENTS_COLLECTOR: Collector = {
  plugin: "GitHub",
  description: "Collects GitHub deployments.",
};
export const GITHUB_DEPLOYMENT_PULL_REQUESTS_COLLECTOR: Collector = {
  plugin: "GitHub",
  description: "Collects pull requests linked to deployments.",
};
export const JIRA_INCIDENTS_COLLECTOR: Collector = {
  plugin: "Jira",
  description: "Collects Jira incidents.",
};

/** Column headers of the "Data sources" dialog table. */
export const DATA_SOURCES_DIALOG_COLUMNS = [
  "PLUGIN",
  "CHECK",
  "VALUE",
  "STATUS",
  "LAST SYNCED",
] as const;

export const DATA_SOURCES_DIALOG_EMPTY_VALUE = "--";
export const DATA_SOURCES_DIALOG_UNAVAILABLE_VALUE = "N/A";
