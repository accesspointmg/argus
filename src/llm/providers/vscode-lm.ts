// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Models offered by VS Code itself, through the `vscode.lm` API.
 *
 * This is the closest thing to Argus's old behavior, and stays the default so
 * an existing install keeps working untouched — but the vendor is now a setting
 * rather than the literal `'copilot'`. Any extension that registers a chat
 * model provider (Copilot, Continue, a self-hosted bridge) is selectable by
 * name, and no API key is involved because VS Code owns the credentials.
 */

import * as vscode from 'vscode';
import type { ChatRequest, LlmProvider, ModelInfo, ProviderId } from '../types';
import { LlmUnavailableError } from '../types';

/** `128000` → `128K context`. Local to this file; the HTTP providers share their own. */
function formatTokens(tokens: number | undefined): string | undefined {
    return tokens && tokens > 0 ? `${Math.round(tokens / 1000)}K context` : undefined;
}

export interface VsCodeLmOptions {
    /** Vendor to select, e.g. `copilot`. */
    vendor: string;
    /** Optional model family, e.g. `gpt-4o`. Empty means "whatever the vendor offers first". */
    family?: string;
}

export class VsCodeLmProvider implements LlmProvider {
    readonly id: ProviderId = 'vscode-lm';

    constructor(private readonly options: VsCodeLmOptions) {}

    get label(): string {
        return this.options.family
            ? `vscode-lm (${this.options.vendor}/${this.options.family})`
            : `vscode-lm (${this.options.vendor})`;
    }

    async isAvailable(): Promise<boolean> {
        try {
            return (await this.select()).length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Model families this vendor currently exposes.
     *
     * The setting stores a *family* (`gpt-4o`), not the per-instance `id`, so
     * that is what goes in {@link ModelInfo.id}. Several entries can share a
     * family, hence the dedupe — otherwise the picker shows the same choice
     * repeatedly.
     */
    async listModels(): Promise<ModelInfo[]> {
        const seen = new Map<string, ModelInfo>();
        for (const model of await vscode.lm.selectChatModels({ vendor: this.options.vendor })) {
            if (!model.family || seen.has(model.family)) {
                continue;
            }
            seen.set(model.family, {
                id: model.family,
                label: model.name || model.family,
                detail: [model.vendor, formatTokens(model.maxInputTokens)]
                    .filter(Boolean).join(' · ') || undefined,
            });
        }
        return [...seen.values()];
    }

    async chat(request: ChatRequest): Promise<string> {
        const models = await this.select();
        if (models.length === 0) {
            throw new LlmUnavailableError(
                `No language model matched vendor "${this.options.vendor}"` +
                `${this.options.family ? ` and family "${this.options.family}"` : ''}. ` +
                `Check the argus.ai.* settings, or install the extension that provides it.`,
            );
        }

        // The VS Code LM API has no system role, so the system prompt leads as a
        // user turn. That is what Argus did before this abstraction existed.
        const messages: vscode.LanguageModelChatMessage[] = [];
        if (request.system) {
            messages.push(vscode.LanguageModelChatMessage.User(request.system));
        }
        for (const message of request.messages) {
            messages.push(
                message.role === 'assistant'
                    ? vscode.LanguageModelChatMessage.Assistant(message.text)
                    : vscode.LanguageModelChatMessage.User(message.text),
            );
        }

        // `maxTokens` has no equivalent here — VS Code and the vendor negotiate
        // limits between themselves — so the request's ceiling is advisory only.
        const source = new vscode.CancellationTokenSource();
        const subscription = request.token?.onCancellationRequested(() => source.cancel());
        try {
            const response = await models[0].sendRequest(messages, {}, source.token);
            let text = '';
            for await (const chunk of response.text) {
                text += chunk;
            }
            return text;
        } finally {
            subscription?.dispose();
            source.dispose();
        }
    }

    private async select(): Promise<readonly vscode.LanguageModelChat[]> {
        const selector: vscode.LanguageModelChatSelector = { vendor: this.options.vendor };
        if (this.options.family) {
            selector.family = this.options.family;
        }
        return vscode.lm.selectChatModels(selector);
    }
}
