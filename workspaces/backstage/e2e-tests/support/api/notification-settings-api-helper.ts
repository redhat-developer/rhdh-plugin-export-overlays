import { Page, expect } from "@playwright/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { NOTIFICATIONS_API_ORIGIN } from "./notifications-helper";

const EMAIL_CHANNEL_ID = "Email";

interface TopicSetting {
  id: string;
  enabled: boolean;
}

interface OriginSetting {
  id: string;
  enabled: boolean;
  topics?: TopicSetting[];
}

interface ChannelSetting {
  id: string;
  enabled?: boolean;
  origins: OriginSetting[];
}

interface NotificationSettings {
  channels: ChannelSetting[];
}

function withEmailOriginState(
  origins: OriginSetting[],
  enabled: boolean,
): OriginSetting[] {
  if (origins.some((origin) => origin.id === NOTIFICATIONS_API_ORIGIN)) {
    return origins.map((origin) =>
      origin.id === NOTIFICATIONS_API_ORIGIN
        ? {
            ...origin,
            enabled,
            topics: origin.topics?.map((topic) => ({ ...topic, enabled })),
          }
        : origin,
    );
  }

  return [
    ...origins,
    {
      id: NOTIFICATIONS_API_ORIGIN,
      enabled,
      topics: [],
    },
  ];
}

export class NotificationSettingsApiHelper {
  constructor(private readonly page: Page) {}

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await new AuthApiHelper(this.page).getToken();

    return {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  async setEmailChannelEnabled(enabled: boolean) {
    const headers = await this.authHeaders();
    const settingsResponse = await this.page.request.get(
      "/api/notifications/settings",
      { headers },
    );
    expect(
      settingsResponse.ok(),
      `get notification settings failed (${settingsResponse.status()}): ${await settingsResponse.text()}`,
    ).toBeTruthy();

    const settings = (await settingsResponse.json()) as NotificationSettings;
    const emailChannel = settings.channels.find(
      (channel) => channel.id === EMAIL_CHANNEL_ID,
    );

    expect(
      emailChannel,
      `Expected "${EMAIL_CHANNEL_ID}" channel in notification settings`,
    ).toBeDefined();

    const updatedSettings: NotificationSettings = {
      channels: settings.channels.map((channel) =>
        channel.id === EMAIL_CHANNEL_ID
          ? {
              ...channel,
              origins: withEmailOriginState(emailChannel!.origins, enabled),
            }
          : channel,
      ),
    };

    const updateResponse = await this.page.request.post(
      "/api/notifications/settings",
      {
        headers,
        data: updatedSettings,
      },
    );
    expect(
      updateResponse.ok(),
      `update notification settings failed (${updateResponse.status()}): ${await updateResponse.text()}`,
    ).toBeTruthy();

    await expect
      .poll(
        async () => {
          const response = await this.page.request.get(
            "/api/notifications/settings",
            { headers },
          );
          if (!response.ok()) {
            return false;
          }

          const currentSettings =
            (await response.json()) as NotificationSettings;
          const email = currentSettings.channels.find(
            (channel) => channel.id === EMAIL_CHANNEL_ID,
          );
          const origin = email?.origins.find(
            (entry) => entry.id === NOTIFICATIONS_API_ORIGIN,
          );

          return origin?.enabled === enabled;
        },
        {
          timeout: 10_000,
          message: `Expected Email notifications from ${NOTIFICATIONS_API_ORIGIN} to be ${enabled ? "enabled" : "disabled"}`,
        },
      )
      .toBe(true);
  }
}
