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

/** Patterns indicating malicious code in generated output. */
export const CODE_OUTPUT_DANGER_PATTERNS: { pattern: RegExp; name: string; severity: string; description: string }[] = [
    // Secrets/credentials
    { pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][^'"]+['"]/gi, name: 'hardcoded_secret', severity: 'error', description: 'Hardcoded secret or credential' },
    { pattern: /ghp_[A-Za-z0-9_]{36}/g, name: 'github_pat', severity: 'error', description: 'GitHub personal access token' },
    { pattern: /glpat-[A-Za-z0-9_-]{20}/g, name: 'gitlab_pat', severity: 'error', description: 'GitLab personal access token' },
    { pattern: /sk-[A-Za-z0-9]{48}/g, name: 'openai_key', severity: 'error', description: 'OpenAI API key' },
    { pattern: /AKIA[A-Z0-9]{16}/g, name: 'aws_access_key', severity: 'error', description: 'AWS access key ID' },
    { pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g, name: 'private_key', severity: 'error', description: 'Private key material' },

    // Dangerous function calls
    { pattern: /\beval\s*\(/g, name: 'eval_call', severity: 'warning', description: 'Use of eval()' },
    { pattern: /\bexec\s*\(/g, name: 'exec_call', severity: 'warning', description: 'Use of exec()' },
    { pattern: /\bspawn\s*\(/g, name: 'spawn_call', severity: 'warning', description: 'Use of spawn()' },
    { pattern: /child_process/g, name: 'child_process_import', severity: 'warning', description: 'Import of child_process module' },
    { pattern: /subprocess\.run/g, name: 'subprocess_run', severity: 'warning', description: 'Use of subprocess.run' },
    { pattern: /os\.system\s*\(/g, name: 'os_system', severity: 'warning', description: 'Use of os.system()' },
    { pattern: /Runtime\.getRuntime\(\)\.exec/g, name: 'java_exec', severity: 'warning', description: 'Java Runtime.exec() call' },
];
