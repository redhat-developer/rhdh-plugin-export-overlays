export type ScorecardMetric = {
  readonly title: string;
  readonly description: string;
  readonly thresholdLabels?: readonly string[];
};

export type ThresholdRule = {
  readonly key: string;
  readonly expression: string;
  readonly color?: string;
};
