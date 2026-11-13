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

/** Maximum retries for transient connection errors (e.g. HAProxy dropping idle keep-alive). */
const CREATE_NOTIFICATION_MAX_RETRIES = 2;

function isTransientConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("socket hang up") || message.includes("ECONNRESET");
}

export async function createNotification(
  notificationTitle: string,
  recipientsOrSeverity?: NotificationRecipients | string,
  severity?: string,
): Promise<string> {
  const { recipients, severity: resolvedSeverity } =
    resolveCreateNotificationArgs(recipientsOrSeverity, severity);

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

  for (let attempt = 0; attempt <= CREATE_NOTIFICATION_MAX_RETRIES; attempt++) {
    const notificationsApi = await RhdhNotificationsApi.build(
      NOTIFICATIONS_API_TOKEN,
    );

    try {
      const response = await notificationsApi.createNotification(notification);
      expect(
        response.ok(),
        `create notification failed (${response.status()}): ${await response.text()}`,
      ).toBeTruthy();

      return title;
    } catch (error) {
      if (
        attempt < CREATE_NOTIFICATION_MAX_RETRIES &&
        isTransientConnectionError(error)
      ) {
        // Stale persistent connection closed by remote (e.g. HAProxy).
        // Rebuild the API instance to get a fresh connection.
        continue;
      }
      throw error;
    }
  }

  // Unreachable — the loop either returns or throws.
  throw new Error("createNotification: retry loop exited unexpectedly");
}
