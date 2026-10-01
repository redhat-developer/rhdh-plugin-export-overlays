import {
  GITHUB_DEPLOYMENTS_COLLECTOR,
  GITHUB_DEPLOYMENT_PULL_REQUESTS_COLLECTOR,
  JIRA_INCIDENTS_COLLECTOR,
} from "./constants";
import type { ScorecardMetric } from "../types";

/** DORA thresholds use elite/medium/low instead of the default success/warning/error. */
export const DORA_THRESHOLD_LABELS = ["Elite", "Medium", "Low"] as const;

export const DORA_ENTITY = "dora-scorecard";

export const DORA_METRICS: readonly ScorecardMetric[] = [
  {
    id: "dora.deploymentFrequency",
    title: "DORA - Deployment Frequency",
    description:
      "Tracks how often code is successfully deployed to production over the past 30 days. Elite performers deploy on demand (multiple times per day).",
    thresholdLabels: DORA_THRESHOLD_LABELS,
    collectors: [GITHUB_DEPLOYMENTS_COLLECTOR],
  },
  {
    id: "dora.medianLeadTimeForChanges",
    title: "DORA - Median Lead Time for Changes",
    aggregationTitle: "DORA - Lead Time for Changes",
    description:
      "Measures the median time from code commit to production deployment over the past 30 days. Elite performers have a lead time of less than 24 hours.",
    thresholdLabels: DORA_THRESHOLD_LABELS,
    collectors: [
      GITHUB_DEPLOYMENTS_COLLECTOR,
      GITHUB_DEPLOYMENT_PULL_REQUESTS_COLLECTOR,
    ],
  },
  {
    id: "dora.changeFailureRate",
    title: "DORA - Change Failure Rate",
    description:
      "Monitors the percentage of deployments that cause a failure in production over the past 30 days. Elite performers maintain a change failure rate below 5%.",
    thresholdLabels: DORA_THRESHOLD_LABELS,
    collectors: [GITHUB_DEPLOYMENTS_COLLECTOR, JIRA_INCIDENTS_COLLECTOR],
  },
  {
    id: "dora.medianTimeToRestore",
    title: "DORA - Median Time to Restore",
    description:
      "Tracks the median time to restore service after an incident over the past 30 days. Elite performers restore service in under one hour.",
    thresholdLabels: DORA_THRESHOLD_LABELS,
    collectors: [JIRA_INCIDENTS_COLLECTOR],
  },
] as const;
