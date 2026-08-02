// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Logger — OutputChannel wrapper with severity levels.
 */

import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export class Logger {
    private channel: vscode.OutputChannel;
    private level: LogLevel;

    constructor(channelName: string = 'Argus', level: LogLevel = 'info') {
        this.channel = vscode.window.createOutputChannel(channelName);
        this.level = level;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    debug(message: string): void {
        this.log('debug', message);
    }

    info(message: string): void {
        this.log('info', message);
    }

    warn(message: string): void {
        this.log('warn', message);
    }

    error(message: string): void {
        this.log('error', message);
    }

    show(): void {
        this.channel.show(true);
    }

    private log(level: LogLevel, message: string): void {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = level.toUpperCase().padEnd(5);
        this.channel.appendLine(`[${timestamp}] ${prefix} ${message}`);
    }

    dispose(): void {
        this.channel.dispose();
    }
}
