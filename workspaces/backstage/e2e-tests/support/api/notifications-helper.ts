import { expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  type NotificationRecipients,
  type NotificationRequest,
  type NotificationSeverity,
  RhdhNotificationsApi,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const NOTIFICATIONS_API_TOKEN = "test-token";
export const NOTIFICATIONS_API_ORIGIN = "test-subject";

const DEFAULT_RECIPIENTS: NotificationRecipients = { type: "broadcast" };

function resolveCreateNotificationArgs(
  recipientsOrSeverity?: NotificationRecipients | string,
  severity?: string,
): { recipients: NotificationRecipients; severity?: string } {
  if (typeof recipientsOrSeverity === "string") {
    return { recipients: DEFAULT_RECIPIENTS, severity: recipientsOrSeverity };
  }

  if (recipientsOrSeverity !== undefined) {
    return { recipients: recipientsOrSeverity, severity };
  }

  return { recipients: DEFAULT_RECIPIENTS, severity };
}

export async function createNotification(
  notificationTitle: string,
  recipientsOrSeverity?: NotificationRecipients | string,
  severity?: string,
): Promise<string> {
  const { recipients, severity: resolvedSeverity } =
    resolveCreateNotificationArgs(recipientsOrSeverity, severity);

  const notificationsApi = await RhdhNotificationsApi.build(
    NOTIFICATIONS_API_TOKEN,
  );
  const uniqueSuffix = crypto.randomUUID();
  const title = resolvedSeverity
    ? `${notificationTitle} ${resolvedSeverity}-${uniqueSuffix}`
    : `${notificationTitle}-${uniqueSuffix}`;
  const apiSeverity = (
    resolvedSeverity ?? "normal"
  ).toLowerCase() as NotificationSeverity;

  const notification: NotificationRequest = {
    recipients,
    payload: {
      title,
      description: `Test ${title}`,
      severity: apiSeverity,
      topic: `Testing ${title}`,
    },
  };

  const response = await notificationsApi.createNotification(notification);
  expect(
    response.ok(),
    `create notification failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();

  return title;
}
