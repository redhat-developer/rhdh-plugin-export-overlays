export type ScorecardMetric = {
  readonly id: string;
  readonly title: string;
  readonly aggregationTitle?: string;
  readonly description: string;
  readonly thresholds?: readonly ThresholdRule[];
  readonly collectors?: readonly Collector[];
};

export type ThresholdRule = {
  readonly keyLabel: string;
  readonly expression: string;
  readonly color?: string;
};

/** Collector used by Scorecard metric providers to gather datasource-specific data. */
export type Collector = {
  readonly plugin: string;
  readonly description: string;
};
