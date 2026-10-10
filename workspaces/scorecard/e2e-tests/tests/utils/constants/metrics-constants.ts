import { ScorecardMetric, ThresholdRule } from "../types";
import {
  GITHUB_DEPLOYMENTS_COLLECTOR,
  GITHUB_DEPLOYMENT_PULL_REQUESTS_COLLECTOR,
  JIRA_INCIDENTS_COLLECTOR,
} from "./constants";

const DEFAULT_NUMBER_THRESHOLDS: ThresholdRule[] = [
  { keyLabel: "Success", expression: "<10" },
  { keyLabel: "Warning", expression: "10-50" },
  { keyLabel: "Error", expression: ">50" },
] as const;
const OPENSSF_THRESHOLDS: ThresholdRule[] = [
  { keyLabel: "Success", expression: ">7" },
  { keyLabel: "Warning", expression: "2-7" },
  { keyLabel: "Error", expression: "<2" },
] as const;
const DEPENDABOT_THRESHOLDS: ThresholdRule[] = [
  { keyLabel: "Success", expression: "<1" },
  { keyLabel: "Warning", expression: "1-7" },
  { keyLabel: "Error", expression: ">7" },
] as const;
const FILECHECK_THRESHOLDS: ThresholdRule[] = [
  {
    keyLabel: "Exist",
    expression: "==true",
    color: "rgb(46, 125, 50)",
  },
  {
    keyLabel: "Missing",
    expression: "==false",
    color: "rgb(211, 47, 47)",
  },
] as const;

export const FILECHECK_METRICS: Record<string, ScorecardMetric> = {
  readme: {
    id: "filecheck.readme",
    title: "File check: readme",
    description: "Checks whether the readme file exists in the repository.",
    thresholds: FILECHECK_THRESHOLDS,
  },
  license: {
    id: "filecheck.license",
    title: "File check: license",
    description: "Checks whether the license file exists in the repository.",
    thresholds: FILECHECK_THRESHOLDS,
  },
  missing: {
    id: "filecheck.missing",
    title: "File check: missing",
    description: "Checks whether the missing file exists in the repository.",
    thresholds: FILECHECK_THRESHOLDS,
  },
} as const;

export const SCORECARD_METRICS: ScorecardMetric[] = [
  {
    id: "github.openPRs",
    title: "GitHub open PRs",
    description:
      "Current count of open Pull Requests for a given GitHub repository.",
    // Custom thresholds
    thresholds: [
      { keyLabel: "Ideal", expression: "<30", color: "rgb(180, 211, 178)" },
      { keyLabel: "Warning", expression: "30-70", color: "rgb(250, 213, 165)" },
      { keyLabel: "Critical", expression: ">70", color: "rgb(250, 160, 160)" },
    ],
  },
  {
    id: "jira.openIssues",
    title: "Jira open blocking tickets",
    description:
      "Highlights the number of critical, blocking issues that are currently open in Jira.",
    thresholds: DEFAULT_NUMBER_THRESHOLDS,
  },
] as const;

export const OPENSSF_METRICS: Record<string, ScorecardMetric> = {
  maintained: {
    id: "openssf.maintained",
    title: "OpenSSF Maintained",
    description:
      'Determines if the project is "actively maintained" according to OpenSSF Security Scorecards.',
    thresholds: OPENSSF_THRESHOLDS,
  },
  // Used when openssf.maintained is disabled via scorecard.io/disabled-metrics
  license: {
    id: "openssf.license",
    title: "OpenSSF License",
    description:
      "Determines if the project has defined a license according to OpenSSF Security Scorecards.",
    thresholds: OPENSSF_THRESHOLDS,
  },
  pinnedDependencies: {
    id: "openssf.pinnedDependencies",
    title: "OpenSSF Pinned Dependencies",
    description:
      "Determines if the project has declared and pinned the dependencies of its build process according to OpenSSF Security Scorecards.",
    thresholds: OPENSSF_THRESHOLDS,
  },
} as const;

export const DEPENDABOT_METRICS = [
  {
    id: "dependabot.alertsCritical",
    title: "Dependabot Critical Alerts",
    description:
      "Current count of open critical Dependabot alerts for a given repository.",
    thresholds: DEPENDABOT_THRESHOLDS,
  },
  {
    id: "dependabot.alertsHigh",
    title: "Dependabot High Alerts",
    description:
      "Current count of open high-severity Dependabot alerts for a given repository.",
    thresholds: DEPENDABOT_THRESHOLDS,
  },
  {
    id: "dependabot.alertsMedium",
    title: "Dependabot Medium Alerts",
    description:
      "Current count of open medium-severity Dependabot alerts for a given repository.",
    thresholds: DEPENDABOT_THRESHOLDS,
  },
  {
    id: "dependabot.alertsLow",
    title: "Dependabot Low Alerts",
    description:
      "Current count of open low-severity Dependabot alerts for a given repository.",
    thresholds: DEPENDABOT_THRESHOLDS,
  },
] as const;

export const DORA_METRICS: readonly ScorecardMetric[] = [
  {
    id: "dora.deploymentFrequency",
    title: "DORA - Deployment Frequency",
    description:
      "Tracks how often code is successfully deployed to production over the past 30 days. Elite performers deploy on demand (multiple times per day).",
    thresholds: [
      { keyLabel: "Elite", expression: ">=7/week" },
      { keyLabel: "Medium", expression: "1-7/week" },
      { keyLabel: "Low", expression: "<1/week" },
    ],
    collectors: [GITHUB_DEPLOYMENTS_COLLECTOR],
  },
  {
    id: "dora.medianLeadTimeForChanges",
    title: "DORA - Median Lead Time for Changes",
    aggregationTitle: "DORA - Lead Time for Changes",
    description:
      "Measures the median time from code commit to production deployment over the past 30 days. Elite performers have a lead time of less than 24 hours.",
    thresholds: [
      { keyLabel: "Elite", expression: "<24 h" },
      { keyLabel: "Medium", expression: "24-168 h" },
      { keyLabel: "Low", expression: ">168 h" },
    ],
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
    thresholds: [
      { keyLabel: "Elite", expression: "<5%" },
      { keyLabel: "Medium", expression: "5-15%" },
      { keyLabel: "Low", expression: ">15%" },
    ],
    collectors: [GITHUB_DEPLOYMENTS_COLLECTOR, JIRA_INCIDENTS_COLLECTOR],
  },
  {
    id: "dora.medianTimeToRestore",
    title: "DORA - Median Time to Restore",
    description:
      "Tracks the median time to restore service after an incident over the past 30 days. Elite performers restore service in under one hour.",
    thresholds: [
      { keyLabel: "Elite", expression: "<1 h" },
      { keyLabel: "Medium", expression: "1-24 h" },
      { keyLabel: "Low", expression: ">24 h" },
    ],
    collectors: [JIRA_INCIDENTS_COLLECTOR],
  },
] as const;
