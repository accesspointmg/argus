// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Live settings access for the security and crypto subsystems.
 *
 * Everything reads `argus.*` at the moment of use so a change in Settings
 * takes effect on the next decision, never after a restart. Classes accept a
 * `SettingReader` so tests can substitute fixed values.
 */

import * as vscode from 'vscode';

/** Read `argus.<key>`, falling back when unset or of the wrong type. */
export type SettingReader = <T>(key: string, fallback: T) => T;

export const readSetting: SettingReader = <T>(key: string, fallback: T): T => {
    const value = vscode.workspace.getConfiguration('argus').get<T>(key);
    if (value === undefined || value === null) { return fallback; }
    if (typeof fallback === 'number') {
        return (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    }
    if (typeof fallback === 'boolean') {
        return (typeof value === 'boolean' ? value : fallback);
    }
    if (Array.isArray(fallback)) {
        return (Array.isArray(value) ? value : fallback);
    }
    return value;
};

/** A reader backed by a plain object — for tests. */
export function fixedSettings(values: Record<string, unknown>): SettingReader {
    return <T>(key: string, fallback: T): T =>
        (key in values ? values[key] as T : fallback);
}
