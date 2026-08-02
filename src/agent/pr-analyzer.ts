// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * PR Analyzer — evaluates competing PRs, ranks them, and can synthesize a "super PR."
 */

import { randomBytes } from 'crypto';
import type { Forge, PullRequest, FileChange } from '../forge/types';
import type { PRAnalysis, SynthesisCandidate, TrackedIssue } from './types';
import type { TrustResolver } from '../security/trust';
import type { StampManager } from '../crypto/stamp';
import type { Logger } from '../util/logger';
import type { LlmService } from '../llm';
import { user } from '../llm';

export class PRAnalyzer {
    constructor(
        private readonly logger: Logger,
        private readonly trustResolver: TrustResolver,
        private readonly stampManager: StampManager,
        private readonly llm: LlmService,
    ) {}

    /**
     * Find and analyze all competing PRs for an issue.
     */
    async analyzeCompetingPRs(
        forge: Forge,
        issue: TrackedIssue,
    ): Promise<PRAnalysis[]> {
        const prs = await forge.listPRsForIssue(issue.issueNumber);

        // Filter to open PRs only, exclude our own if we know it
        const competing = prs.filter((pr) =>
            pr.state === 'open' && pr.number !== issue.prNumber
        );

        if (competing.length === 0) {
            return [];
        }

        this.logger.info(`Found ${competing.length} competing PR(s) for issue #${issue.issueNumber}`);

        const analyses: PRAnalysis[] = [];
        for (const pr of competing) {
            try {
                const analysis = await this.analyzePR(forge, pr);
                analyses.push(analysis);
            } catch (err) {
                this.logger.warn(`Failed to analyze competing PR #${pr.number}: ${err}`);
            }
        }

        // Sort by overall score (descending)
        analyses.sort((a, b) => b.overallScore - a.overallScore);

        return analyses;
    }

    private async analyzePR(
        forge: Forge,
        pr: PullRequest,
    ): Promise<PRAnalysis> {
        // Resolve trust for the PR author
        const trust = await this.trustResolver.resolve(forge, pr.author);

        // Get file changes and CI status
        const [files, checks] = await Promise.all([
            forge.getPRFiles(pr.number),
            forge.getCheckRuns(pr.head),
        ]);

        const ciPassing = checks.length === 0 ||
            checks.every((c) => c.status === 'completed' && c.conclusion === 'success');

        // Detect if this is another Argus instance's PR
        const isOtherArgus = this.stampManager.hasStamp(pr.body) &&
                              this.stampManager.extractInstanceId(pr.body) !== this.stampManager.instanceId;
        const isOurInstance = this.stampManager.hasStamp(pr.body) &&
                               this.stampManager.extractInstanceId(pr.body) === this.stampManager.instanceId;

        // Use LLM to evaluate code quality
        const llmAnalysis = await this.evaluateWithLLM(forge, pr, files, ciPassing);

        return {
            prId: pr.id,
            prNumber: pr.number,
            prUrl: pr.url,
            author: pr.author,
            trustScore: trust.effectiveTrustScore,
            isOurInstance,
            isOtherArgus,
            correctness: llmAnalysis.correctness,
            completeness: llmAnalysis.completeness,
            codeQuality: llmAnalysis.codeQuality,
            testCoverage: llmAnalysis.testCoverage,
            minimalInvasiveness: llmAnalysis.minimalInvasiveness,
            ciPassing,
            overallScore: this.computeOverallScore(llmAnalysis, ciPassing, trust.effectiveTrustScore),
            strengths: llmAnalysis.strengths,
            weaknesses: llmAnalysis.weaknesses,
            novelInsights: llmAnalysis.novelInsights,
            risksIntroduced: llmAnalysis.risksIntroduced,
            overlapWithOurs: llmAnalysis.overlapWithOurs,
            uniqueContributions: llmAnalysis.uniqueContributions,
        };
    }

    private computeOverallScore(
        analysis: any,
        ciPassing: boolean,
        trustScore: number,
    ): number {
        const weighted =
            analysis.correctness * 0.30 +
            analysis.completeness * 0.20 +
            analysis.codeQuality * 0.20 +
            analysis.testCoverage * 0.15 +
            analysis.minimalInvasiveness * 0.15;

        // CI passing is a strong signal
        const ciBonus = ciPassing ? 0 : -0.2;

        // Trust adds a small bonus
        const trustBonus = trustScore * 0.05;

        return Math.max(0, Math.min(1, weighted + ciBonus + trustBonus));
    }

    private async evaluateWithLLM(
        forge: Forge,
        pr: PullRequest,
        files: FileChange[],
        ciPassing: boolean,
    ): Promise<any> {
        const canary = randomBytes(8).toString('hex');

        const filesSummary = files.map((f) =>
            `${f.status} ${f.path} (+${f.additions}/-${f.deletions})`
        ).join('\n');

        const patches = files
            .filter((f) => f.patch)
            .map((f) => `=== ${f.path} ===\n${f.patch!.substring(0, 2_000)}`)
            .join('\n\n')
            .substring(0, 20_000);

        const systemPrompt = `You are Argus's PR quality evaluator. Analyze a pull request for technical merit.
Include "${canary}" at the start of your response.

Respond ONLY with JSON:
{
  "canary": "${canary}",
  "correctness": 0.0-1.0,
  "completeness": 0.0-1.0,
  "codeQuality": 0.0-1.0,
  "testCoverage": 0.0-1.0,
  "minimalInvasiveness": 0.0-1.0,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "novelInsights": ["..."],
  "risksIntroduced": ["..."],
  "overlapWithOurs": 0.0-1.0,
  "uniqueContributions": ["..."]
}`;

        const userPrompt = `Analyze PR #${pr.number} by @${pr.author}:

Title: ${pr.title}
CI: ${ciPassing ? 'passing' : 'failing/pending'}
Files: ${files.length}

File Summary:
${filesSummary}

Patches:
${patches}

Evaluate the technical quality.`;

        if (!(await this.llm.isAvailable())) {
            // Fallback: heuristic scoring
            return {
                correctness: 0.5,
                completeness: 0.5,
                codeQuality: 0.5,
                testCoverage: 0,
                minimalInvasiveness: files.length <= 5 ? 0.8 : 0.4,
                strengths: [],
                weaknesses: ['Could not evaluate with LLM'],
                novelInsights: [],
                risksIntroduced: [],
                overlapWithOurs: 0,
                uniqueContributions: [],
            };
        }

        const responseText = await this.llm.chat({
            system: systemPrompt,
            messages: [user(userPrompt)],
        });

        if (!responseText.includes(canary)) {
            this.logger.warn('PR evaluation canary failed');
            return {
                correctness: 0.5, completeness: 0.5, codeQuality: 0.5,
                testCoverage: 0, minimalInvasiveness: 0.5,
                strengths: [], weaknesses: ['Canary verification failed'],
                novelInsights: [], risksIntroduced: [], overlapWithOurs: 0, uniqueContributions: [],
            };
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { throw new Error('No JSON in PR evaluation response'); }

        return JSON.parse(jsonMatch[0]);
    }

    /**
     * Determine if we should synthesize a "super PR" from competing PRs.
     */
    shouldSynthesize(
        ourAnalysis: PRAnalysis | undefined,
        competing: PRAnalysis[],
    ): boolean {
        if (competing.length === 0) { return false; }

        // If any competitor scores significantly higher than ours
        if (ourAnalysis) {
            const bestCompetitor = competing[0]; // Already sorted
            if (bestCompetitor.overallScore > ourAnalysis.overallScore + 0.15) {
                return true;
            }
            // If competitors have unique contributions we're missing
            const totalUnique = competing.reduce(
                (sum, pr) => sum + pr.uniqueContributions.length, 0
            );
            if (totalUnique >= 3) { return true; }
        }

        return false;
    }

    /**
     * Plan the synthesis of a super PR from the best elements of competing PRs.
     */
    async planSynthesis(
        competing: PRAnalysis[],
        ourAnalysis?: PRAnalysis,
    ): Promise<SynthesisCandidate> {
        const allPRs = ourAnalysis ? [ourAnalysis, ...competing] : competing;
        const sorted = [...allPRs].sort((a, b) => b.overallScore - a.overallScore);

        return {
            sourcePRs: sorted,
            elementsFromEach: sorted.map((pr) => ({
                prNumber: pr.prNumber,
                elements: pr.strengths.slice(0, 3),
                reason: `Score: ${(pr.overallScore * 100).toFixed(0)}%, ${pr.uniqueContributions.length} unique contributions`,
            })),
            projectedScore: Math.min(
                1.0,
                sorted[0].overallScore + sorted.slice(1).reduce(
                    (sum, pr) => sum + pr.uniqueContributions.length * 0.03, 0
                ),
            ),
            conflictsToResolve: this.identifyConflicts(sorted),
        };
    }

    private identifyConflicts(prs: PRAnalysis[]): string[] {
        const conflicts: string[] = [];

        // Basic overlap detection
        for (let i = 0; i < prs.length; i++) {
            for (let j = i + 1; j < prs.length; j++) {
                if (prs[i].overlapWithOurs > 0.5 || prs[j].overlapWithOurs > 0.5) {
                    conflicts.push(
                        `PR #${prs[i].prNumber} and PR #${prs[j].prNumber} have significant overlap`
                    );
                }
            }
        }

        return conflicts;
    }
}
