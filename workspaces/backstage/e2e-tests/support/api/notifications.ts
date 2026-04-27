import {
  APIRequestContext,
  APIResponse,
  request,
} from "@red-hat-developer-hub/e2e-test-utils/test";

export interface Payload {
  title: string;
  description: string;
  severity: string;
  topic: string;
}

export interface Recipients {
  type: string;
  entityRef: string[];
}

export interface Notifications {
  recipients: Recipients;
  payload: Payload;
}

export class RhdhNotificationsApi {
  private readonly apiUrl = `${process.env.RHDH_BASE_URL}/api/`;
  /* eslint-disable @typescript-eslint/naming-convention */
  private readonly authHeader: {
    Accept: "application/json";
    Authorization: string;
  };
  /* eslint-enable @typescript-eslint/naming-convention */
  private myContext!: APIRequestContext;
  private constructor(private readonly token: string) {
    this.authHeader = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
  }

  public static async build(token: string): Promise<RhdhNotificationsApi> {
    const instance = new RhdhNotificationsApi(token);
    instance.myContext = await request.newContext({
      baseURL: instance.apiUrl,
      extraHTTPHeaders: instance.authHeader,
    });
    return instance;
  }

  // Create notification
  public async createNotification(
    notifications: Notifications,
  ): Promise<APIResponse> {
    return await this.myContext.post("notifications", { data: notifications });
  }

  // Mark all notifications as read
  public async markAllNotificationsAsRead(): Promise<APIResponse> {
    return await this.myContext.patch("notifications", {
      data: {
        ids: [],
        read: true,
      },
    });
  }
}
