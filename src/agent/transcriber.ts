// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Transcriber — formats AI reasoning as structured PR comments.
 *
 * Every step of Argus's process is written as a PR comment so that
 * human reviewers can "follow along the logic."
 */

import type { Forge } from '../forge/types';
import type { IssueEvaluation, CodingIteration, TrackedIssue } from './types';
import type { InvestigationResult } from './investigator';
import type { PRAnalysis, SynthesisCandidate } from './types';
import type { StampManager } from '../crypto/stamp';
import type { Logger } from '../util/logger';

export class Transcriber {
    constructor(
        private readonly logger: Logger,
        private readonly stampManager: StampManager,
    ) {}

    /**
     * Post the initial evaluation as a PR comment.
     */
    async postEvaluation(
        forge: Forge,
        prNumber: number,
        issue: TrackedIssue,
        evaluation: IssueEvaluation,
    ): Promise<void> {
        const content = `## 🔍 Issue Evaluation

| Field | Value |
|-------|-------|
| **Issue** | #${issue.issueNumber} |
| **Category** | ${evaluation.category} |
| **Severity** | ${evaluation.severity} |
| **Merit** | ${evaluation.merit ? '✅ Yes' : '❌ No'} |
| **Confidence** | ${(evaluation.confidence * 100).toFixed(0)}% |

### Reasoning
${evaluation.reasoning}

### Proposed Approach
${evaluation.proposedApproach}

### Affected Files
${evaluation.affectedFiles.map((f) => `- \`${f}\``).join('\n') || '_None identified_'}

### Suggested Labels
${evaluation.suggestedLabels.map((l) => `\`${l}\``).join(', ') || '_None_'}

${evaluation.duplicateOf ? `> ⚠️ Possible duplicate of #${evaluation.duplicateOf}` : ''}`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
        this.logger.debug(`Posted evaluation comment on PR #${prNumber}`);
    }

    /**
     * Post investigation results as a PR comment.
     */
    async postInvestigation(
        forge: Forge,
        prNumber: number,
        investigation: InvestigationResult,
    ): Promise<void> {
        const content = `## 🔎 Code Investigation

**Files examined:** ${investigation.filesExamined.length}
**Confidence:** ${(investigation.confidence * 100).toFixed(0)}%

### Suggested Changes
${investigation.suggestedChanges.map((c) =>
    `- **${c.approach}** \`${c.path}\`: ${c.description}`
).join('\n') || '_No changes suggested_'}

### Dependencies
${investigation.dependencies.map((d) => `- \`${d}\``).join('\n') || '_None identified_'}

### Notes
${investigation.notes || '_None_'}`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
        this.logger.debug(`Posted investigation comment on PR #${prNumber}`);
    }

    /**
     * Post a coding iteration result as a PR comment.
     */
    async postIteration(
        forge: Forge,
        prNumber: number,
        iteration: CodingIteration,
    ): Promise<void> {
        const ciIcon = iteration.ciResult === 'passing' ? '✅' :
                       iteration.ciResult === 'failing' ? '❌' :
                       '⏳';

        const content = `## 🔧 Coding Iteration ${iteration.iteration}

### Changes
${iteration.filesChanged.map((f) =>
    `- \`${f.path}\` (+${f.linesAdded}/-${f.linesRemoved})`
).join('\n') || '_No files changed_'}

### Commit
\`${iteration.commitMessage}\`

### Reasoning
${iteration.reasoning}

### Self-Review
${iteration.selfReview}

### CI Status ${ciIcon}
${iteration.ciResult === 'failing' && iteration.ciLog
    ? `<details><summary>CI Log (truncated)</summary>\n\n\`\`\`\n${iteration.ciLog.substring(0, 5_000)}\n\`\`\`\n</details>`
    : iteration.ciResult || 'pending'}`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
        this.logger.debug(`Posted iteration ${iteration.iteration} comment on PR #${prNumber}`);
    }

    /**
     * Post a summary comment when all iterations are complete.
     */
    async postSummary(
        forge: Forge,
        prNumber: number,
        issue: TrackedIssue,
        iterations: CodingIteration[],
    ): Promise<void> {
        const lastIteration = iterations[iterations.length - 1];
        const ciPassed = lastIteration?.ciResult === 'passing';
        const totalFiles = new Set(iterations.flatMap((i) => i.filesChanged.map((f) => f.path))).size;

        const content = `## 📋 Resolution Summary

| Field | Value |
|-------|-------|
| **Issue** | #${issue.issueNumber} |
| **Iterations** | ${iterations.length} / ${issue.maxIterations} |
| **Files changed** | ${totalFiles} |
| **CI** | ${ciPassed ? '✅ Passing' : '❌ Not passing'} |

### Iteration History
${iterations.map((it) => {
    const ci = it.ciResult === 'passing' ? '✅' : it.ciResult === 'failing' ? '❌' : '⏳';
    return `${it.iteration}. ${ci} ${it.commitMessage} (${it.filesChanged.length} files)`;
}).join('\n')}

---

> 🤖 This PR was generated by **Argus** — an AI code agent.
> It should be reviewed by a human before merging.
> Argus **never** merges PRs.`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
        this.logger.debug(`Posted summary comment on PR #${prNumber}`);
    }

    /**
     * Post competitive PR analysis results.
     */
    async postCompetitiveAnalysis(
        forge: Forge,
        prNumber: number,
        analyses: PRAnalysis[],
    ): Promise<void> {
        if (analyses.length === 0) { return; }

        const ranked = [...analyses].sort((a, b) => b.overallScore - a.overallScore);

        const content = `## ⚔️ Competitive PR Analysis

Found **${analyses.length}** competing PR(s) for this issue.

### Rankings
${ranked.map((pr, idx) => {
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
    const source = pr.isOurInstance ? '(ours)' : pr.isOtherArgus ? '(other Argus)' : '(human)';
    return `${medal} **PR #${pr.prNumber}** by @${pr.author} ${source} — Score: **${(pr.overallScore * 100).toFixed(0)}%**
   Correctness: ${(pr.correctness * 100).toFixed(0)}% · Quality: ${(pr.codeQuality * 100).toFixed(0)}% · Tests: ${(pr.testCoverage * 100).toFixed(0)}% · CI: ${pr.ciPassing ? '✅' : '❌'}
   Strengths: ${pr.strengths.join(', ') || 'none'}
   Weaknesses: ${pr.weaknesses.join(', ') || 'none'}`;
}).join('\n\n')}`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
    }

    /**
     * Post synthesis plan.
     */
    async postSynthesisPlan(
        forge: Forge,
        prNumber: number,
        synthesis: SynthesisCandidate,
    ): Promise<void> {
        const content = `## 🧬 Super PR Synthesis

Combining the best elements from **${synthesis.sourcePRs.length}** PRs.
Projected score: **${(synthesis.projectedScore * 100).toFixed(0)}%**

### Elements Selected
${synthesis.elementsFromEach.map((e) =>
    `**From PR #${e.prNumber}:**\n${e.elements.map((el) => `  - ${el}`).join('\n')}\n  _Reason: ${e.reason}_`
).join('\n\n')}

### Conflicts to Resolve
${synthesis.conflictsToResolve.map((c) => `- ${c}`).join('\n') || '_None_'}`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
    }
}
