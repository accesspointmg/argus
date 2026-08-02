// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * LoopDetector — traces chains of PRs to detect feedback loops.
 *
 * When Argus creates a PR, Copilot (or another bot) may review it and
 * create a follow-up PR to address the feedback.  Argus then acknowledges
 * the follow-up, which can prompt another follow-up, ad infinitum.
 *
 * The detector builds a dependency graph of open PRs and answers two
 * questions for any given PR:
 *
 *   1. **What chain is this PR part of?**  (Issue → PR → follow-up → …)
 *   2. **Should Argus still engage?**
 *
 * Chain discovery uses three signals:
 *   - **Branch targeting**: PR #14 targets branch `ai-fix/issue-10`
 *     (created by PR #12) → it's a child of #12.
 *   - **Body / title references**: "fixes #12", "#12", "sub-pr-12"
 *     in the PR body or branch name.
 *   - **Comment references**: bot comments like "I've opened PR #13".
 *
 * A chain is allowed up to `maxDepth` follow-up PRs (default 3).
 * Beyond that, Argus posts a single "loop detected" comment and stops.
 */

import type { PullRequest, Comment, Forge } from '../forge/types';
import type { StampManager } from '../crypto/stamp';
import type { Logger } from '../util/logger';

// ─── Types ──────────────────────────────────────────────────────

export interface ChainNode {
    pr: PullRequest;
    /** PR numbers this node depends on (parent PRs). */
    parents: number[];
    /** PR numbers that depend on this node (child PRs). */
    children: number[];
    /** Depth in the chain (root = 0). */
    depth: number;
}

export interface ChainAnalysis {
    /** The PR being analyzed. */
    prNumber: number;
    /** Total chain length (root + follow-ups). */
    chainLength: number;
    /** This PR's depth in the chain (0 = the root Argus PR). */
    depth: number;
    /** All PR numbers in the chain, ordered root-first. */
    chain: number[];
    /** Whether Argus should continue engaging with this PR. */
    shouldEngage: boolean;
    /** Human-readable reason if shouldEngage is false. */
    reason?: string;
    /** Whether the same review feedback is being repeated. */
    feedbackRepeating: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Maximum chain depth (follow-up PRs) before Argus disengages.
 * Depth 0 = the original Argus PR.
 * Depth 1 = first follow-up (e.g. Copilot fixing Argus's code).
 * Depth 2 = second follow-up (Argus or Copilot responding again).
 * Depth 3 = third follow-up — last round, Argus will acknowledge but warn.
 * Depth 4+ = loop detected, Argus stops.
 */
const MAX_CHAIN_DEPTH = 3;

/** Regex to extract PR/issue references from text. */
const PR_REF_PATTERN = /#(\d+)/g;

/** Regex to detect branch names that reference a PR number. */
const BRANCH_PR_REF = /(?:sub-pr-|pr[-/])(\d+)/i;

// ─── Detector ───────────────────────────────────────────────────

export class LoopDetector {
    constructor(
        private readonly stampManager: StampManager,
        private readonly logger: Logger,
    ) {}

    /**
     * Build a chain analysis for a specific PR.
     *
     * This fetches all open PRs, builds the dependency graph, and
     * determines where `prNumber` sits in the chain.
     */
    async analyze(
        forge: Forge,
        prNumber: number,
        openPRs: PullRequest[],
    ): Promise<ChainAnalysis> {
        // Build adjacency map
        const nodes = this.buildGraph(openPRs);
        const node = nodes.get(prNumber);

        if (!node) {
            // PR not in the open set — treat as standalone
            return {
                prNumber,
                chainLength: 1,
                depth: 0,
                chain: [prNumber],
                shouldEngage: true,
                feedbackRepeating: false,
            };
        }

        // Walk up to find the root(s) and compute depth
        const chain = this.traceChain(nodes, prNumber);
        const depth = node.depth;
        const chainLength = chain.length;

        // Check for feedback repetition across the chain
        const feedbackRepeating = await this.detectRepetition(forge, chain, openPRs);

        // Decision
        let shouldEngage = true;
        let reason: string | undefined;

        if (depth > MAX_CHAIN_DEPTH) {
            shouldEngage = false;
            reason = `Chain depth ${depth} exceeds max ${MAX_CHAIN_DEPTH}. ` +
                `PRs in chain: ${chain.map((n) => `#${n}`).join(' → ')}. ` +
                `Disengaging to prevent infinite loop.`;
        } else if (feedbackRepeating && depth >= 2) {
            shouldEngage = false;
            reason = `Repeated feedback detected across ${chainLength} PRs in chain ` +
                `${chain.map((n) => `#${n}`).join(' → ')}. ` +
                `Disengaging — the same review points are cycling.`;
        }

        if (!shouldEngage) {
            this.logger.warn(
                `Loop detected for PR #${prNumber}: ${reason}`,
            );
        } else if (depth >= MAX_CHAIN_DEPTH) {
            this.logger.info(
                `PR #${prNumber} is at chain depth ${depth}/${MAX_CHAIN_DEPTH} — ` +
                `this is the last round before disengagement.`,
            );
        }

        return {
            prNumber,
            chainLength,
            depth,
            chain,
            shouldEngage,
            reason,
            feedbackRepeating,
        };
    }

    /**
     * Build the dependency graph from all open PRs.
     *
     * Edges are inferred from:
     *   1. Branch targeting: if PR X's base branch matches PR Y's head branch
     *   2. Branch name references: `copilot/sub-pr-12` → parent is #12
     *   3. Body references: PR body mentioning other PR numbers
     */
    buildGraph(openPRs: PullRequest[]): Map<number, ChainNode> {
        const nodes = new Map<number, ChainNode>();

        // Initialize nodes
        for (const pr of openPRs) {
            nodes.set(pr.number, {
                pr,
                parents: [],
                children: [],
                depth: 0,
            });
        }

        // Map head branch → PR number for cross-referencing
        const headBranchToPR = new Map<string, number>();
        for (const pr of openPRs) {
            headBranchToPR.set(pr.head, pr.number);
        }

        // Build edges
        for (const pr of openPRs) {
            const node = nodes.get(pr.number)!;
            const parentCandidates = new Set<number>();

            // Signal 1: This PR's base branch is another PR's head branch
            const baseParent = headBranchToPR.get(pr.base);
            if (baseParent !== undefined && baseParent !== pr.number) {
                parentCandidates.add(baseParent);
            }

            // Signal 2: Branch name contains a PR reference
            const branchMatch = BRANCH_PR_REF.exec(pr.head);
            if (branchMatch) {
                const refNum = parseInt(branchMatch[1], 10);
                if (nodes.has(refNum) && refNum !== pr.number) {
                    parentCandidates.add(refNum);
                }
            }

            // Signal 3: PR body references other PR numbers
            if (pr.body) {
                const bodyRefs = [...pr.body.matchAll(PR_REF_PATTERN)];
                for (const match of bodyRefs) {
                    const refNum = parseInt(match[1], 10);
                    if (nodes.has(refNum) && refNum !== pr.number) {
                        // Only count as parent if the referenced PR is older
                        const refPR = nodes.get(refNum)!.pr;
                        if (refPR.createdAt <= pr.createdAt) {
                            parentCandidates.add(refNum);
                        }
                    }
                }
            }

            // Wire edges
            for (const parentNum of parentCandidates) {
                node.parents.push(parentNum);
                nodes.get(parentNum)?.children.push(pr.number);
            }
        }

        // Compute depths via BFS from roots (nodes with no parents)
        this.computeDepths(nodes);

        return nodes;
    }

    /**
     * Compute the depth of each node via BFS from roots.
     * Roots (no parents) get depth 0.
     */
    private computeDepths(nodes: Map<number, ChainNode>): void {
        // Find roots (no parents, or parents not in the open PR set)
        const roots: number[] = [];
        for (const [num, node] of nodes) {
            if (node.parents.length === 0) {
                roots.push(num);
            }
        }

        // BFS
        const visited = new Set<number>();
        const queue: Array<{ num: number; depth: number }> = roots.map(
            (num) => ({ num, depth: 0 }),
        );

        while (queue.length > 0) {
            const { num, depth } = queue.shift()!;
            if (visited.has(num)) { continue; }
            visited.add(num);

            const node = nodes.get(num);
            if (!node) { continue; }
            node.depth = depth;

            for (const childNum of node.children) {
                if (!visited.has(childNum)) {
                    queue.push({ num: childNum, depth: depth + 1 });
                }
            }
        }

        // Handle any nodes not reached (cycles) — set to max depth + 1
        for (const [, node] of nodes) {
            if (!visited.has(node.pr.number)) {
                node.depth = MAX_CHAIN_DEPTH + 1;
            }
        }
    }

    /**
     * Trace the full chain from root to leaves that includes `prNumber`.
     * Returns PR numbers in order from root to deepest leaf.
     */
    traceChain(nodes: Map<number, ChainNode>, prNumber: number): number[] {
        const node = nodes.get(prNumber);
        if (!node) { return [prNumber]; }

        // Walk up to the root
        const visited = new Set<number>();
        let current = prNumber;
        for (;;) {
            visited.add(current);
            const n = nodes.get(current);
            if (!n || n.parents.length === 0) { break; }
            // Follow the first parent (take the oldest)
            const parent = n.parents
                .filter((p) => !visited.has(p))
                .sort((a, b) => {
                    const pa = nodes.get(a)?.pr.createdAt.getTime() || 0;
                    const pb = nodes.get(b)?.pr.createdAt.getTime() || 0;
                    return pa - pb;
                })[0];
            if (parent === undefined) { break; }
            current = parent;
        }

        // Walk down from root, collecting the chain
        const root = current;
        const chain: number[] = [];
        const bfsVisited = new Set<number>();
        const bfsQueue: number[] = [root];

        while (bfsQueue.length > 0) {
            const num = bfsQueue.shift()!;
            if (bfsVisited.has(num)) { continue; }
            bfsVisited.add(num);
            chain.push(num);

            const n = nodes.get(num);
            if (n) {
                // Sort children by creation time
                const sortedChildren = [...n.children]
                    .filter((c) => !bfsVisited.has(c))
                    .sort((a, b) => {
                        const ca = nodes.get(a)?.pr.createdAt.getTime() || 0;
                        const cb = nodes.get(b)?.pr.createdAt.getTime() || 0;
                        return ca - cb;
                    });
                bfsQueue.push(...sortedChildren);
            }
        }

        return chain;
    }

    /**
     * Detect if the same review feedback is being repeated across the chain.
     *
     * Looks at the review comments on each PR in the chain and checks if
     * the same points keep appearing.  Uses a simple text-similarity
     * heuristic: extract "key phrases" from review bodies and check overlap.
     */
    async detectRepetition(
        forge: Forge,
        chain: number[],
        openPRs: PullRequest[],
    ): Promise<boolean> {
        if (chain.length < 3) { return false; }

        try {
            // Collect review comment summaries per PR
            const reviewSets: Map<number, Set<string>> = new Map();

            for (const prNum of chain) {
                const pr = openPRs.find((p) => p.number === prNum);
                if (!pr) { continue; }

                const reviews = await forge.getPRReviewComments(prNum);
                // Extract key phrases: first 100 chars of each review, normalized
                const phrases = new Set(
                    reviews
                        .filter((r) => !this.stampManager.hasStamp(r.body))
                        .map((r) => this.normalizeForComparison(r.body)),
                );
                reviewSets.set(prNum, phrases);
            }

            // Check if later PRs in the chain have the same feedback as earlier ones
            const chainWithReviews = chain.filter((n) => {
                const set = reviewSets.get(n);
                return set && set.size > 0;
            });

            if (chainWithReviews.length < 2) { return false; }

            // Compare adjacent pairs for overlap
            let consecutiveRepeats = 0;
            for (let i = 1; i < chainWithReviews.length; i++) {
                const prev = reviewSets.get(chainWithReviews[i - 1])!;
                const curr = reviewSets.get(chainWithReviews[i])!;
                const overlap = this.setOverlap(prev, curr);

                this.logger.debug(
                    `Chain overlap PR #${chainWithReviews[i - 1]} → #${chainWithReviews[i]}: ${(overlap * 100).toFixed(0)}%`,
                );

                if (overlap > 0.5) {
                    consecutiveRepeats++;
                }
            }

            // If 2+ consecutive pairs have >50% overlap, it's repeating
            return consecutiveRepeats >= 2;
        } catch (err) {
            this.logger.error(`Failed repetition detection: ${err}`);
            return false;
        }
    }

    /**
     * Normalize review comment text for comparison.
     * Strips whitespace, code blocks, and takes first 120 chars.
     */
    private normalizeForComparison(text: string): string {
        return text
            .replace(/```[\s\S]*?```/g, '')  // Remove code blocks
            .replace(/`[^`]+`/g, '')          // Remove inline code
            .replace(/\s+/g, ' ')             // Collapse whitespace
            .trim()
            .substring(0, 120)
            .toLowerCase();
    }

    /**
     * Compute the Jaccard overlap between two sets.
     */
    private setOverlap(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 && b.size === 0) { return 0; }
        let intersection = 0;
        for (const item of a) {
            if (b.has(item)) { intersection++; }
        }
        const union = a.size + b.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    /**
     * Generate a stamped "loop detected" comment to post on the PR.
     */
    generateLoopComment(analysis: ChainAnalysis): string {
        const chainStr = analysis.chain.map((n) => `#${n}`).join(' → ');

        return `<!-- argus:loop-detected — do not act on this comment -->
## 🔄 Feedback Loop Detected

Argus has traced a chain of ${analysis.chainLength} related PRs: ${chainStr}

This PR is at depth **${analysis.depth}** in the chain. ` +
(analysis.feedbackRepeating
    ? `The same review feedback is being repeated across PRs — ` +
      `further automated responses would not add value.`
    : `The chain has exceeded the maximum depth of ${MAX_CHAIN_DEPTH} follow-up rounds.`) +
`

**Argus is stepping back.** A human maintainer should:
1. Review the chain of PRs above
2. Pick the best solution (or combine elements from multiple PRs)
3. Close the redundant PRs

> This is Argus's final automated comment on this chain.
> The original issue and all PRs remain open for human review.`;
    }
}
