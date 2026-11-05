import type { Collector } from "../types";

export const DEFAULT_THRESHOLDS = [
  { keyLabel: "Success", expression: "<10", color: "rgb(46, 125, 50)" },
  { keyLabel: "Warning", expression: "10-50", color: "rgb(237, 108, 2)" },
  { keyLabel: "Error", expression: ">50", color: "rgb(211, 47, 47)" },
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

export const DATA_SOURCES_DIALOG_EMPTY_VALUE = "--";
export const DATA_SOURCES_DIALOG_UNAVAILABLE_VALUE = "N/A";
