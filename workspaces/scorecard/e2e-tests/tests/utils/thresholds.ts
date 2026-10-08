import type { Locator } from "@playwright/test";
import type { ThresholdRule } from "./types";

export function thresholdRuleLegendLocator(
  card: Locator,
  threshold: ThresholdRule,
  showExpression = false,
): Locator {
  const label = threshold.keyLabel;
  if (!showExpression) {
    return card.getByText(label, { exact: true });
  }
  const withParantheses = card.getByText(`${label} (${threshold.expression})`, {
    exact: true,
  });
  const withoutParentheses = card.getByText(
    `${label} ${threshold.expression}`,
    { exact: true },
  );
  return withParantheses.or(withoutParentheses);
}
