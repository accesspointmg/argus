// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

import * as path from 'path';

async function main() {
    // This launches VS Code's test runner
    const { runTests } = await import('@vscode/test-electron');

    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
    });
}

main().catch((err) => {
    console.error('Failed to run tests:', err);
    process.exit(1);
});
