import { APIRequestContext, request } from "@playwright/test";

/* eslint-disable @typescript-eslint/naming-convention --
   Mailpit REST responses use PascalCase / snake_case field names from the upstream API. */

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessage {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
}

interface MailpitSearchResponse {
  messages_count: number;
  messages: MailpitMessage[];
}

export class MailpitApiHelper {
  private context: APIRequestContext | undefined;

  constructor(private readonly baseUrl: string) {}

  private async getContext(): Promise<APIRequestContext> {
    if (!this.context) {
      this.context = await request.newContext({
        baseURL: this.baseUrl.replace(/\/$/, ""),
        ignoreHTTPSErrors: true,
      });
    }
    return this.context;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = undefined;
    }
  }

  async waitUntilReady(timeout = 60_000): Promise<void> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        const context = await this.getContext();
        const response = await context.get("/api/v1/messages", {
          params: { limit: 1 },
        });

        if (response.ok()) {
          return;
        }
      } catch {
        // Mailpit route or pod may still be starting.
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error(
      `Timed out waiting for Mailpit HTTP API at ${this.baseUrl}`,
    );
  }

  async countMessages(query: string): Promise<number> {
    const response = await this.search(query);
    return response.messages_count;
  }

  async waitForMessages(
    query: string,
    opts?: { timeout?: number; expectedCount?: number },
  ): Promise<MailpitMessage[]> {
    const timeout = opts?.timeout ?? 60_000;
    const expectedCount = opts?.expectedCount ?? 1;
    const deadline = Date.now() + timeout;
    let lastCount = 0;

    while (Date.now() < deadline) {
      const response = await this.search(query);
      lastCount = response.messages_count;

      if (lastCount >= expectedCount) {
        return response.messages;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error(
      `Timed out waiting for Mailpit messages matching "${query}" (expected >= ${expectedCount}, last count ${lastCount})`,
    );
  }

  private async search(query: string): Promise<MailpitSearchResponse> {
    const context = await this.getContext();
    const response = await context.get("/api/v1/search", {
      params: { query },
    });

    if (!response.ok()) {
      throw new Error(
        `Mailpit search failed (${response.status()}): ${await response.text()}`,
      );
    }

    return (await response.json()) as MailpitSearchResponse;
  }
}
