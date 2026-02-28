const SERVER_URL = process.env.NAVVY_SERVER_URL || 'http://localhost:3300';
const APPROVAL_TIMEOUT_MS = 300000; // 5 minutes

export async function requestApproval(toolName: string, toolInput: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APPROVAL_TIMEOUT_MS);

    const response = await fetch(`${SERVER_URL}/api/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName, toolInput }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[approval-gate] Server returned ${response.status}`);
      return false; // Deny on error
    }

    const result = await response.json() as { approved: boolean };
    return result.approved;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.error('[approval-gate] Approval request timed out');
    } else {
      console.error('[approval-gate] Failed to request approval:', (err as Error).message);
    }
    return false; // Deny on error
  }
}

export function checkNeedsApproval(toolName: string, toolInput: string): { needsApproval: boolean; reason: string } | null {
  // Local quick-check for dangerous patterns (mirrors server-side patterns)
  // The server does the authoritative check, but this avoids unnecessary HTTP calls
  const DANGEROUS_PATTERNS = [
    { toolName: 'system_shell', inputMatch: /git push|rm -rf|sudo|shutdown|reboot/i, reason: 'Destructive system command' },
    { toolName: 'browser_click', inputMatch: /purchase|buy|checkout|pay|submit.*payment/i, reason: 'Potential purchase action' },
    { toolName: 'browser_fill_form', inputMatch: /credit.?card|cvv|ssn/i, reason: 'Sensitive financial data entry' },
    { toolName: 'system_shell', inputMatch: /curl.*\|.*sh|wget.*\|.*sh/i, reason: 'Remote code execution pattern' },
  ];

  for (const pattern of DANGEROUS_PATTERNS) {
    if (!toolName.includes(pattern.toolName)) continue;
    if (pattern.inputMatch.test(toolInput)) {
      return { needsApproval: true, reason: pattern.reason };
    }
  }

  return null;
}
