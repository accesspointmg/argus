// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Investigator — uses code search & file reading to gather context for issue resolution.
 */

import { randomBytes } from 'crypto';
import type { Forge } from '../forge/types';
import type { IssueEvaluation } from './types';
import type { Logger } from '../util/logger';
import type { LlmService } from '../llm';
import { user } from '../llm';

export interface InvestigationResult {
    filesExamined: string[];
    relevantSnippets: { path: string; content: string; lineStart: number }[];
    dependencies: string[];
    suggestedChanges: {
        path: string;
        description: string;
        approach: 'modify' | 'create' | 'delete';
    }[];
    confidence: number;
    notes: string;
}

export class Investigator {
    constructor(
        private readonly logger: Logger,
        private readonly llm: LlmService,
    ) {}

    /**
     * Investigate the codebase for context relevant to an evaluated issue.
     */
    async investigate(
        forge: Forge,
        evaluation: IssueEvaluation,
        branch: string,
    ): Promise<InvestigationResult> {
        const filesExamined: string[] = [];
        const relevantSnippets: InvestigationResult['relevantSnippets'] = [];

        // 1. Search the codebase for files mentioned in the evaluation
        for (const filePath of evaluation.affectedFiles.slice(0, 10)) {
            try {
                const content = await forge.getFileContent(branch, filePath);
                filesExamined.push(filePath);
                relevantSnippets.push({
                    path: filePath,
                    content: content.substring(0, 5_000),
                    lineStart: 1,
                });
            } catch {
                this.logger.debug(`File not found during investigation: ${filePath}`);
            }
        }

        // 2. Search for code related to key terms from the evaluation
        const searchTerms = this.extractSearchTerms(evaluation);
        for (const term of searchTerms.slice(0, 5)) {
            try {
                const results = await forge.searchCode(term);
                for (const result of results.slice(0, 3)) {
                    if (!filesExamined.includes(result.path)) {
                        filesExamined.push(result.path);
                        try {
                            const content = await forge.getFileContent(branch, result.path);
                            relevantSnippets.push({
                                path: result.path,
                                content: content.substring(0, 5_000),
                                lineStart: 1,
                            });
                        } catch {
                            // File content unavailable
                        }
                    }
                }
            } catch {
                this.logger.debug(`Code search failed for term: ${term}`);
            }
        }

        // 3. Use LLM to synthesize context and suggest changes
        return await this.synthesizeWithLLM(
            forge,
            evaluation,
            filesExamined,
            relevantSnippets,
        );
    }

    private extractSearchTerms(evaluation: IssueEvaluation): string[] {
        const terms: string[] = [];

        // Extract identifiers from the proposed approach
        const identifierPattern = /\b[A-Z][a-zA-Z0-9]+\b/g;
        const matches = evaluation.proposedApproach.match(identifierPattern) || [];
        terms.push(...matches.slice(0, 5));

        // Extract from reasoning
        const keywords = evaluation.reasoning
            .split(/\s+/)
            .filter((w) => w.length > 5 && /^[a-zA-Z_]/.test(w))
            .slice(0, 5);
        terms.push(...keywords);

        return [...new Set(terms)];
    }

    private async synthesizeWithLLM(
        forge: Forge,
        evaluation: IssueEvaluation,
        filesExamined: string[],
        snippets: InvestigationResult['relevantSnippets'],
    ): Promise<InvestigationResult> {
        const canary = randomBytes(8).toString('hex');

        const codeContext = snippets
            .map((s) => `=== ${s.path} (line ${s.lineStart}) ===\n${s.content}`)
            .join('\n\n');

        const systemPrompt = `You are Argus's code investigator. Analyze the code context and determine the exact changes
needed to resolve the issue. Include "${canary}" at the start of your response.

Respond ONLY with valid JSON:
{
  "canary": "${canary}",
  "suggestedChanges": [
    { "path": "file.ts", "description": "what to change", "approach": "modify"|"create"|"delete" }
  ],
  "dependencies": ["list of files that would be affected by changes"],
  "confidence": 0.0-1.0,
  "notes": "any important context for the coder"
}`;

        const userPrompt = `Issue evaluation:
- Category: ${evaluation.category}
- Severity: ${evaluation.severity}
- Approach: ${evaluation.proposedApproach}
- Reasoning: ${evaluation.reasoning}

Code context (${snippets.length} files examined):
${codeContext.substring(0, 20_000)}

What specific changes are needed?`;

        if (!(await this.llm.isAvailable())) {
            // Fallback without LLM
            return {
                filesExamined,
                relevantSnippets: snippets,
                dependencies: [],
                suggestedChanges: evaluation.affectedFiles.map((f) => ({
                    path: f,
                    description: evaluation.proposedApproach,
                    approach: 'modify' as const,
                })),
                confidence: 0.3,
                notes: 'No LLM available — using heuristic analysis',
            };
        }

        const responseText = await this.llm.chat({
            system: systemPrompt,
            messages: [user(userPrompt)],
        });

        if (!responseText.includes(canary)) {
            this.logger.warn('Canary missing from investigation — using raw file analysis');
            return {
                filesExamined,
                relevantSnippets: snippets,
                dependencies: [],
                suggestedChanges: [],
                confidence: 0.2,
                notes: 'Investigation canary failed — using limited results',
            };
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No JSON in investigation response');
        }

        const parsed = JSON.parse(jsonMatch[0]);

        return {
            filesExamined,
            relevantSnippets: snippets,
            dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
            suggestedChanges: Array.isArray(parsed.suggestedChanges)
                ? parsed.suggestedChanges.map((c: any) => ({
                    path: String(c.path),
                    description: String(c.description),
                    approach: c.approach || 'modify',
                }))
                : [],
            confidence: parsed.confidence ?? 0.5,
            notes: String(parsed.notes || ''),
        };
    }
}
