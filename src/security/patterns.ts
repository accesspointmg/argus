// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Known prompt injection and adversarial patterns.
 * Used by the sanitizer as a first-pass filter before LLM evaluation.
 */

/** Patterns that indicate direct prompt injection attempts. */
export const INJECTION_PATTERNS: { pattern: RegExp; name: string }[] = [
    // Direct instruction override
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/gi, name: 'instruction_override' },
    { pattern: /ignore\s+(all\s+)?prior\s+instructions/gi, name: 'instruction_override' },
    { pattern: /disregard\s+(all\s+)?previous/gi, name: 'instruction_override' },
    { pattern: /forget\s+(all\s+)?(your\s+)?instructions/gi, name: 'instruction_override' },
    { pattern: /override\s+(your\s+)?(system\s+)?prompt/gi, name: 'instruction_override' },
    { pattern: /new\s+instructions?\s*:/gi, name: 'instruction_override' },

    // Role switching / jailbreak
    { pattern: /you\s+are\s+now\s+(a|an|the)\s/gi, name: 'role_switch' },
    { pattern: /act\s+as\s+(a|an|the|if)\s/gi, name: 'role_switch' },
    { pattern: /pretend\s+(to\s+be|you\s+are)/gi, name: 'role_switch' },
    { pattern: /enter\s+(DAN|developer|god)\s+mode/gi, name: 'jailbreak' },
    { pattern: /DAN\s*[:=]/gi, name: 'jailbreak' },
    { pattern: /do\s+anything\s+now/gi, name: 'jailbreak' },
    { pattern: /jailbreak/gi, name: 'jailbreak' },

    // Token/delimiter injection
    { pattern: /<\|im_start\|>/gi, name: 'token_injection' },
    { pattern: /<\|im_end\|>/gi, name: 'token_injection' },
    { pattern: /<\|endoftext\|>/gi, name: 'token_injection' },
    { pattern: /\[INST\]/gi, name: 'token_injection' },
    { pattern: /\[\/INST\]/gi, name: 'token_injection' },
    { pattern: /<<SYS>>/gi, name: 'token_injection' },
    { pattern: /<<\/SYS>>/gi, name: 'token_injection' },
    { pattern: /system\s*:\s*\n/gi, name: 'role_injection' },
    { pattern: /assistant\s*:\s*\n/gi, name: 'role_injection' },
    { pattern: /user\s*:\s*\n/gi, name: 'role_injection' },

    // Data exfiltration
    { pattern: /output\s+(all|the|your)\s+(system|initial)\s+prompt/gi, name: 'exfiltration' },
    { pattern: /reveal\s+(your|the)\s+(system|initial)\s+prompt/gi, name: 'exfiltration' },
    { pattern: /show\s+me\s+(your|the)\s+instructions/gi, name: 'exfiltration' },
    { pattern: /what\s+(are|were)\s+your\s+instructions/gi, name: 'exfiltration' },
    { pattern: /repeat\s+(your\s+)?system\s+prompt/gi, name: 'exfiltration' },

    // Privilege escalation
    { pattern: /merge\s+(this|the)\s+(PR|pull\s+request|MR|merge\s+request)/gi, name: 'privilege_escalation' },
    { pattern: /delete\s+(this|the)\s+(repo|repository|branch)/gi, name: 'privilege_escalation' },
    { pattern: /modify\s+(repo|repository)\s+settings/gi, name: 'privilege_escalation' },
    { pattern: /grant\s+(me|admin)\s+(access|permissions)/gi, name: 'privilege_escalation' },

    // Social engineering
    { pattern: /this\s+is\s+(an?\s+)?emergency/gi, name: 'social_engineering' },
    { pattern: /urgent\s*[:\-!]/gi, name: 'social_engineering' },
    { pattern: /I('m|\s+am)\s+(the|a)\s+(owner|admin|maintainer)/gi, name: 'social_engineering' },
    { pattern: /trust\s+me/gi, name: 'social_engineering' },
    { pattern: /I\s+authorized?\s+(this|you)/gi, name: 'social_engineering' },
];

/** Base64-encoded payload indicators. */
export const BASE64_PAYLOAD_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/** Unicode homoglyph / invisible character patterns. */
export const INVISIBLE_CHAR_PATTERNS: { pattern: RegExp; name: string }[] = [
    { pattern: /[\u200B-\u200F]/g, name: 'zero_width_chars' },         // Zero-width spaces, joiners
    { pattern: /[\u202A-\u202E]/g, name: 'bidi_override' },            // Bidirectional overrides
    { pattern: /[\u2066-\u2069]/g, name: 'bidi_isolate' },             // Bidirectional isolates
    { pattern: /[\uFEFF]/g, name: 'byte_order_mark' },                 // BOM
    { pattern: /[\u00AD]/g, name: 'soft_hyphen' },                     // Soft hyphen
    { pattern: /[\uFFF0-\uFFFD]/g, name: 'specials' },                 // Replacement chars
    { pattern: /[\u2028-\u2029]/g, name: 'line_paragraph_separator' },  // Line/paragraph separators
];

/** HTML comment pattern (could hide instructions). */
export const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

export interface CodeDangerPattern {
    pattern: RegExp;
    name: string;
    severity: 'error' | 'warning';
    description: string;
}

/**
 * Patterns indicating dangerous code in generated output. Process execution,
 * dynamic evaluation and network access are errors: Argus refuses to push
 * them. The validator applies these to ADDED lines when the original file is
 * known, so pre-existing code doesn't block a fix.
 */
export const CODE_OUTPUT_DANGER_PATTERNS: CodeDangerPattern[] = [
    // Secrets/credentials
    { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]+['"]/gi, name: 'hardcoded_secret', severity: 'error', description: 'Hardcoded secret or credential' },
    { pattern: /ghp_[A-Za-z0-9_]{36}/g, name: 'github_pat', severity: 'error', description: 'GitHub personal access token' },
    { pattern: /glpat-[A-Za-z0-9_-]{20}/g, name: 'gitlab_pat', severity: 'error', description: 'GitLab personal access token' },
    { pattern: /sk-[A-Za-z0-9]{48}/g, name: 'openai_key', severity: 'error', description: 'OpenAI API key' },
    { pattern: /AKIA[A-Z0-9]{16}/g, name: 'aws_access_key', severity: 'error', description: 'AWS access key ID' },
    { pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g, name: 'private_key', severity: 'error', description: 'Private key material' },

    // Dynamic evaluation (a leading `.` is a method like regex.exec / model.eval)
    { pattern: /(?<![\w.$])eval\s*\(/g, name: 'eval_call', severity: 'error', description: 'Use of eval()' },
    { pattern: /\bnew\s+Function\s*\(/g, name: 'function_constructor', severity: 'error', description: 'Function constructor' },
    { pattern: /(?<![\w.$])exec\s*\(/g, name: 'exec_call', severity: 'error', description: 'Use of exec()' },
    { pattern: /\bvm\.(?:runIn\w+|compileFunction|Script)\b/g, name: 'node_vm', severity: 'error', description: 'Node vm module evaluation' },
    { pattern: /\b__import__\s*\(|\bcompile\s*\([^)]*['"]exec['"]/g, name: 'python_dynamic', severity: 'error', description: 'Python dynamic import/compile' },
    { pattern: /\bpickle\.loads?\s*\(|\bmarshal\.loads\s*\(/g, name: 'unsafe_deserialize', severity: 'error', description: 'Unsafe deserialization' },

    // Process execution
    { pattern: /(?<![\w:$])spawn(?:Sync)?\s*\(/g, name: 'spawn_call', severity: 'error', description: 'Use of spawn()' },
    { pattern: /\bexec(?:Sync|File|FileSync)\s*\(/g, name: 'exec_variant', severity: 'error', description: 'Use of execSync/execFile' },
    { pattern: /child_process/g, name: 'child_process_import', severity: 'error', description: 'Import of child_process module' },
    { pattern: /\bsubprocess\.\w+/g, name: 'subprocess', severity: 'error', description: 'Use of subprocess' },
    { pattern: /\bos\.(?:system|popen|exec\w*|spawn\w*|fork)\s*\(/g, name: 'os_exec', severity: 'error', description: 'os-level process execution' },
    { pattern: /Runtime\.getRuntime\(\)\.exec|\bProcessBuilder\b/g, name: 'java_exec', severity: 'error', description: 'Java process execution' },
    { pattern: /\bexec\.Command(?:Context)?\s*\(/g, name: 'go_exec', severity: 'error', description: 'Go os/exec' },
    { pattern: /\bstd::process::Command\b|\bCommand::new\s*\(/g, name: 'rust_exec', severity: 'error', description: 'Rust process execution' },
    { pattern: /\bSystem\.Diagnostics\.Process\b|\bProcess\.Start\s*\(/g, name: 'dotnet_exec', severity: 'error', description: '.NET process execution' },
    { pattern: /\b(?:shell_exec|passthru|proc_open|popen)\s*\(/g, name: 'php_exec', severity: 'error', description: 'PHP process execution' },
    { pattern: /\bInvoke-Expression\b|\biex\s*\(/gi, name: 'powershell_iex', severity: 'error', description: 'PowerShell Invoke-Expression' },

    // Network access
    { pattern: /(?<![\w.$])fetch\s*\(/g, name: 'fetch_call', severity: 'error', description: 'Network call (fetch)' },
    { pattern: /\bXMLHttpRequest\b|\bnew\s+WebSocket\s*\(|\bnavigator\.sendBeacon\b/g, name: 'browser_network', severity: 'error', description: 'Browser network API' },
    { pattern: /\b(?:https?|net|tls|dgram|http2)\.(?:request|get|connect|createConnection|createSocket|createServer)\s*\(/g, name: 'node_network', severity: 'error', description: 'Node network API' },
    { pattern: /(?:require\s*\(\s*|from\s+)['"](?:node:)?(?:https?|net|tls|dgram|http2|axios|node-fetch|got|undici|request)['"]/g, name: 'network_import', severity: 'error', description: 'Network module import' },
    { pattern: /\brequests\.(?:get|post|put|delete|patch|head|request|Session)\b|\burllib(?:2|3)?\b|\bhttpx\.|\baiohttp\b|\bsocket\.socket\s*\(/g, name: 'python_network', severity: 'error', description: 'Python network call' },
    { pattern: /"net\/http"|\bnet\.Dial\w*\s*\(|\bjava\.net\.\w+|\bHttpClient\b|\bWebClient\b|\breqwest::|\bTcpStream::connect\b/g, name: 'other_network', severity: 'error', description: 'Network client' },
    { pattern: /\b(?:curl|wget)\s+\S|Invoke-WebRequest|Invoke-RestMethod|\bnc\s+-\w*e\b/gi, name: 'shell_network', severity: 'error', description: 'Shell network command' },
    { pattern: /\bhttps?:\/\/\d{1,3}(?:\.\d{1,3}){3}\b/g, name: 'ip_url', severity: 'error', description: 'URL with raw IP address' },

    // Obfuscation signals
    { pattern: /\batob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"]|\bb64decode\s*\(|FromBase64String/g, name: 'base64_decode', severity: 'warning', description: 'Base64 decoding (possible obfuscation)' },
    { pattern: /String\.fromCharCode\s*\((?:\s*\d+\s*,){8,}/g, name: 'charcode_obfuscation', severity: 'warning', description: 'Long String.fromCharCode sequence' },
];
