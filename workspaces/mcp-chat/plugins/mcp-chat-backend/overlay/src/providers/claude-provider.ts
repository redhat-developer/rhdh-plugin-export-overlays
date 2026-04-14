/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { LLMProvider } from './base-provider';
import { ChatMessage, Tool, ChatResponse, ToolCall } from '../types';

/**
 * Anthropic Claude API provider.
 *
 * Overlay changes vs upstream:
 * - System messages passed as top-level `system` param (upstream drops them)
 * - Tool results use proper `tool_result` content blocks
 * - Assistant tool_calls use proper `tool_use` content blocks
 * - temperature: 0.2 for deterministic tool calling
 * - max_tokens: 16384 for sonnet 4.6 / opus 4.6
 *
 * @public
 */
export class ClaudeProvider extends LLMProvider {
  async sendMessage(
    messages: ChatMessage[],
    tools?: Tool[],
  ): Promise<ChatResponse> {
    const requestBody = this.formatRequest(messages, tools);
    const response = await this.makeRequest('/messages', requestBody);
    return this.parseResponse(response);
  }

  async testConnection(): Promise<{
    connected: boolean;
    models?: string[];
    error?: string;
  }> {
    try {
      const testMessages = [{ role: 'user' as const, content: 'Hello' }];
      const requestBody = {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Claude API error (${response.status})`;

        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error?.message) {
            errorMessage = errorData.error.message;
          }
        } catch {
          errorMessage =
            errorText.length > 100
              ? `${errorText.substring(0, 100)}...`
              : errorText;
        }

        if (response.status === 401) {
          errorMessage =
            'Invalid API key. Please check your Claude API key configuration.';
        } else if (response.status === 429) {
          errorMessage =
            'Rate limit exceeded. Please try again later or check your Claude usage limits.';
        } else if (response.status === 403) {
          errorMessage =
            'Access forbidden. Please check your API key permissions.';
        }

        return {
          connected: false,
          error: errorMessage,
        };
      }

      return {
        connected: true,
        models: [this.model],
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  protected formatRequest(messages: ChatMessage[], tools?: Tool[]): any {
    const systemText = this.extractSystemPrompt(messages);
    const claudeMessages = this.convertToAnthropicFormat(messages);

    const request: any = {
      model: this.model,
      max_tokens: 16384,
      temperature: 0.2,
      messages: claudeMessages,
    };

    if (systemText) {
      request.system = systemText;
    }

    if (tools && tools.length > 0) {
      request.tools = this.convertToAnthropicTools(tools);
    }

    return request;
  }

  protected parseResponse(response: any): ChatResponse {
    const content = response.content || [];
    const textContent = content.find((c: any) => c.type === 'text')?.text || '';

    const toolCalls: ToolCall[] = content
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({
        id: c.id,
        type: 'function' as const,
        function: {
          name: c.name,
          arguments: JSON.stringify(c.input),
        },
      }));

    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
        },
      ],
      usage: response.usage
        ? {
            prompt_tokens: response.usage.input_tokens || 0,
            completion_tokens: response.usage.output_tokens || 0,
            total_tokens:
              (response.usage.input_tokens || 0) +
              (response.usage.output_tokens || 0),
          }
        : undefined,
    };
  }

  private extractSystemPrompt(messages: ChatMessage[]): string | undefined {
    const systemMessages = messages.filter(msg => msg.role === 'system');
    if (systemMessages.length === 0) return undefined;
    return systemMessages.map(msg => msg.content || '').join('\n\n');
  }

  private convertToAnthropicFormat(messages: ChatMessage[]) {
    return messages
      .filter(msg => msg.role !== 'system')
      .map(msg => {
        // Tool result → proper tool_result content block
        if (msg.role === 'tool' && msg.tool_call_id) {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: msg.tool_call_id,
                content: msg.content || '',
              },
            ],
          };
        }

        // Assistant with tool_calls → tool_use content blocks
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          const contentBlocks: any[] = [];

          if (msg.content) {
            contentBlocks.push({ type: 'text', text: msg.content });
          }

          for (const tc of msg.tool_calls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }

          return {
            role: 'assistant' as const,
            content: contentBlocks,
          };
        }

        return {
          role: msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: msg.content || '',
        };
      });
  }

  private convertToAnthropicTools(tools: Tool[]) {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
}
