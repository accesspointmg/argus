// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Public surface of the LLM subsystem. Call sites import from here, not from
 * individual provider modules — nothing outside this folder should know which
 * vendors exist.
 */

export * from './types';
export { LlmService, readAiSettings, apiKeyStorageKey, providerNeedsKey } from './service';
export type { AiSettings } from './service';
export { LlmThrottle } from './throttle';
