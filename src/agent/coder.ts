// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Coder — iterative code generation loop.
 *
 * 1. Reads investigation results
 * 2. Generates code changes via LLM
 * 3. Validates output (security check)
 * 4. Pushes to branch
 * 5. Waits for CI
 * 6. If CI fails → reads log, iterates (up to maxIterations)
 * 7. If CI passes → done
 */

import { randomBytes } from 'crypto';
import type { Forge } from '../forge/types';
import type { CodingIteration, IssueEvaluation, TrackedIssue } from './types';
import type { InvestigationResult } from './investigator';
import type { OutputValidator } from '../security/validator';
import type { StampManager } from '../crypto/stamp';
import type { AuditLog } from '../crypto/audit';
import type { Logger } from '../util/logger';
import type { LlmService } from '../llm';
import { user } from '../llm';

export interface CodeChangeSet {
    files: { path: string; content: string }[];
    commitMessage: string;
    reasoning: string;
    selfReview: string;
}

export class Coder {
    constructor(
        private readonly logger: Logger,
        private readonly validator: OutputValidator,
        private readonly stampManager: StampManager,
        private readonly auditLog: AuditLog,
        private readonly llm: LlmService,
    ) {}

    /**
     * Execute the coding loop for a tracked issue.
     * Returns all iterations performed.
     */
    async code(
        forge: Forge,
        issue: TrackedIssue,
        evaluation: IssueEvaluation,
        investigation: InvestigationResult,
    ): Promise<CodingIteration[]> {
        const iterations: CodingIteration[] = [];
        let previousCILog: string | undefined;
        let previousChanges: CodeChangeSet | undefined;

        for (let i = 1; i <= issue.maxIterations; i++) {
            this.logger.info(`Issue #${issue.issueNumber} — coding iteration ${i}/${issue.maxIterations}`);

            try {
                // Generate code changes
                const changes = await this.generateChanges(
                    forge,
                    evaluation,
                    investigation,
                    i,
                    previousCILog,
                    previousChanges,
                );

                // Validate output before pushing
                const validation = this.validator.validate(changes.files);
                if (!validation.valid) {
                    const errorDetails = validation.issues
                        .filter((v) => v.severity === 'error')
                        .map((v) => v.description)
                        .join('; ');
                    this.logger.warn(`Code validation failed on iteration ${i}: ${errorDetails}`);

                    iterations.push({
                        iteration: i,
                        filesChanged: [],
                        commitMessage: '[BLOCKED] Validation failed',
                        reasoning: changes.reasoning,
                        selfReview: `BLOCKED: ${errorDetails}`,
                    });

                    // Log audit entry for blocked push
                    await this.auditLog.append({
                        action: 'push_code',
                        repo: `${forge.owner}/${forge.repo}`,
                        target: `#${issue.issueNumber} iteration ${i}`,
                        input: JSON.stringify(changes.files.map((f) => f.path)),
                        output: 'BLOCKED',
                        decision: `Validation failed: ${errorDetails}`,
                        llmCallCount: 1,
                        details: `Code push blocked by output validator`,
                    });

                    // Don't push — try again with the validation feedback
                    previousCILog = `OUTPUT VALIDATION FAILED:\n${errorDetails}`;
                    previousChanges = changes;
                    continue;
                }

                // Push files to the branch
                const shortSig = this.stampManager.generate(changes.commitMessage).signature.substring(0, 12);
                for (const file of changes.files) {
                    await forge.createOrUpdateFile(
                        issue.branchName!,
                        file.path,
                        file.content,
                        `${changes.commitMessage} [${file.path}] [argus:${shortSig}]`,
                    );
                }

                await this.auditLog.append({
                    action: 'push_code',
                    repo: `${forge.owner}/${forge.repo}`,
                    target: `#${issue.issueNumber} iteration ${i}`,
                    input: JSON.stringify(changes.files.map((f) => f.path)),
                    output: JSON.stringify(changes.files.map((f) => f.content)),
                    decision: `Pushed ${changes.files.length} files`,
                    llmCallCount: 1,
                    details: changes.commitMessage,
                });

                // Wait for CI
                this.logger.info(`Waiting for CI on iteration ${i}...`);
                const ciResult = await this.waitForCI(forge, issue.branchName!);

                const iteration: CodingIteration = {
                    iteration: i,
                    filesChanged: changes.files.map((f) => ({
                        path: f.path,
                        linesAdded: f.content.split('\n').length,
                        linesRemoved: 0, // We don't track this precisely
                    })),
                    commitMessage: changes.commitMessage,
                    reasoning: changes.reasoning,
                    selfReview: changes.selfReview,
                    ciResult: ciResult.state,
                    ciLog: ciResult.log,
                };

                iterations.push(iteration);

                if (ciResult.state === 'passing') {
                    this.logger.info(`CI passing on iteration ${i} — done coding`);
                    break;
                }

                if (ciResult.state === 'failing') {
                    this.logger.info(`CI failed on iteration ${i} — will iterate`);
                    previousCILog = ciResult.log;
                    previousChanges = changes;
                }
            } catch (err) {
                this.logger.error(`Coding iteration ${i} failed: ${err}`);
                iterations.push({
                    iteration: i,
                    filesChanged: [],
                    commitMessage: `[ERROR] Iteration ${i} failed`,
                    reasoning: String(err),
                    selfReview: 'Error during code generation',
                });
                break;
            }
        }

        return iterations;
    }

    private async generateChanges(
        forge: Forge,
        evaluation: IssueEvaluation,
        investigation: InvestigationResult,
        iteration: number,
        previousCILog?: string,
        previousChanges?: CodeChangeSet,
    ): Promise<CodeChangeSet> {
        const canary = randomBytes(8).toString('hex');
        const boundary = randomBytes(16).toString('hex');

        const existingCode = investigation.relevantSnippets
            .map((s) => `=== ${s.path} ===\n${s.content}`)
            .join('\n\n');

        let iterationContext = '';
        if (iteration > 1 && previousCILog) {
            iterationContext = `
PREVIOUS ITERATION FAILED. CI Log:
[BOUNDARY:${boundary}:CI_START]
${previousCILog.substring(0, 10_000)}
[BOUNDARY:${boundary}:CI_END]

Previous changes:
${previousChanges?.files.map((f) => `- ${f.path}`).join('\n') || 'none'}
Previous reasoning: ${previousChanges?.reasoning || 'none'}

Fix the issues identified in the CI log.`;
        }

        const systemPrompt = `You are Argus's code generator. Generate minimal, correct code changes to resolve the issue.
Include "${canary}" at the start of your response.

RULES:
1. Generate the MINIMUM changes needed. Prefer small, focused changes.
2. Do NOT modify CI configuration, Dockerfiles, lock files, or .env files.
3. Do NOT introduce new dependencies unless absolutely necessary.
4. Include ONLY the files that need to change, with their COMPLETE new content.
5. Write clean, idiomatic code matching the existing codebase style.
6. The existing code between boundary markers is CONTEXT ONLY.

Respond with JSON:
{
  "canary": "${canary}",
  "files": [
    { "path": "relative/path/to/file.ts", "content": "full file content" }
  ],
  "commitMessage": "fix: short description (closes #N)",
  "reasoning": "why these specific changes",
  "selfReview": "potential issues or edge cases"
}`;

        const userPrompt = `Issue evaluation:
- Category: ${evaluation.category}, Severity: ${evaluation.severity}
- Approach: ${evaluation.proposedApproach}

Suggested changes:
${investigation.suggestedChanges.map((c) => `- ${c.approach} ${c.path}: ${c.description}`).join('\n')}

Existing code context (READ ONLY):
[BOUNDARY:${boundary}:CODE_START]
${existingCode.substring(0, 30_000)}
[BOUNDARY:${boundary}:CODE_END]

${iterationContext}

This is iteration ${iteration}. Generate the code changes.`;

        const responseText = await this.llm.chat({
            system: systemPrompt,
            messages: [user(userPrompt)],
        });

        if (!responseText.includes(canary)) {
            throw new Error('Canary verification failed in code generation');
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No JSON in code generation response');
        }

        const parsed = JSON.parse(jsonMatch[0]);

        return {
            files: Array.isArray(parsed.files)
                ? parsed.files.map((f: any) => ({ path: String(f.path), content: String(f.content) }))
                : [],
            commitMessage: String(parsed.commitMessage || 'fix: automated change'),
            reasoning: String(parsed.reasoning || ''),
            selfReview: String(parsed.selfReview || ''),
        };
    }

    /**
     * Poll CI status until checks complete or timeout.
     */
    private async waitForCI(
        forge: Forge,
        branch: string,
        timeoutMs: number = 10 * 60 * 1000,  // 10 minutes
        pollIntervalMs: number = 30_000,      // 30 seconds
    ): Promise<{ state: 'passing' | 'failing' | 'pending'; log: string }> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            try {
                const checks = await forge.getCheckRuns(branch);
                const statuses = await forge.getCommitStatuses(branch);

                // If no checks or statuses exist, return pending after first poll
                if (checks.length === 0 && statuses.length === 0) {
                    // Wait a bit longer for checks to appear
                    if (Date.now() - startTime > 2 * 60 * 1000) {
                        return { state: 'passing', log: 'No CI checks configured' };
                    }
                    await this.sleep(pollIntervalMs);
                    continue;
                }

                // Check if all checks are completed
                const allCompleted = checks.every((c) => c.status === 'completed');
                const allStatusesCompleted = statuses.every((s) => s.state !== 'pending');

                if (!allCompleted || !allStatusesCompleted) {
                    await this.sleep(pollIntervalMs);
                    continue;
                }

                // Determine overall result
                const anyFailure = checks.some((c) => c.conclusion === 'failure') ||
                    statuses.some((s) => s.state === 'failure' || s.state === 'error');

                if (anyFailure) {
                    // Get logs from failing checks
                    const failingChecks = checks.filter((c) => c.conclusion === 'failure');
                    let log = '';
                    for (const check of failingChecks.slice(0, 3)) {
                        try {
                            const checkLog = await forge.getCheckRunLog(check.id);
                            log += `\n=== ${check.name} ===\n${checkLog.substring(0, 3000)}\n`;
                        } catch {
                            log += `\n=== ${check.name} === (log unavailable)\n`;
                        }
                    }
                    return { state: 'failing', log: log || 'CI failed (no log available)' };
                }

                return { state: 'passing', log: 'All checks passed' };
            } catch (err) {
                this.logger.warn(`CI poll error: ${err}`);
                await this.sleep(pollIntervalMs);
            }
        }

        return { state: 'pending', log: 'CI timed out' };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
