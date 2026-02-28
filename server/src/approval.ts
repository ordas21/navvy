import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const POLICIES_FILE = path.join(DATA_DIR, 'approval-policies.json');

// --- Types ---

export interface ApprovalPolicy {
  id: string;
  pattern: { toolName?: string; inputMatch?: string; domainMatch?: string };
  action: 'require_approval' | 'auto_allow' | 'auto_deny';
  trustLevel: 'dangerous' | 'sensitive' | 'normal';
  createdAt: number;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: string;
  trustLevel: string;
  reason: string;
  timestamp: number;
}

interface PolicyStore {
  version: 1;
  policies: ApprovalPolicy[];
}

// --- Built-in dangerous patterns (always require approval unless overridden) ---

const DANGEROUS_PATTERNS: Array<{ toolName: string; inputMatch: string; trustLevel: 'dangerous' | 'sensitive'; reason: string }> = [
  { toolName: 'system_shell', inputMatch: 'git push|rm -rf|sudo|shutdown|reboot', trustLevel: 'dangerous', reason: 'Destructive system command' },
  { toolName: 'browser_click', inputMatch: 'purchase|buy|checkout|pay|submit.*payment', trustLevel: 'dangerous', reason: 'Potential purchase action' },
  { toolName: 'browser_fill_form', inputMatch: 'credit.?card|cvv|ssn', trustLevel: 'dangerous', reason: 'Sensitive financial data entry' },
  { toolName: 'system_shell', inputMatch: 'curl.*\\|.*sh|wget.*\\|.*sh', trustLevel: 'dangerous', reason: 'Remote code execution pattern' },
  { toolName: 'system_kill_process', inputMatch: '.*', trustLevel: 'sensitive', reason: 'Process termination' },
  { toolName: 'system_write_file', inputMatch: '\\.env|credentials|secret|password|token', trustLevel: 'sensitive', reason: 'Writing to sensitive file' },
];

// --- Pending approvals (in-memory, keyed by approval ID) ---

const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// --- Storage ---

export function loadPolicies(): PolicyStore {
  try {
    const raw = fs.readFileSync(POLICIES_FILE, 'utf-8');
    return JSON.parse(raw) as PolicyStore;
  } catch {
    return { version: 1, policies: [] };
  }
}

export function savePolicies(store: PolicyStore): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = POLICIES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, POLICIES_FILE);
}

// --- Policy Matching ---

export function checkApproval(toolName: string, toolInput: string, _hostname?: string): { needsApproval: boolean; trustLevel: string; reason: string } | null {
  const store = loadPolicies();

  // Check user-defined policies first (higher priority)
  for (const policy of store.policies) {
    if (policy.pattern.toolName && !toolName.includes(policy.pattern.toolName)) continue;
    if (policy.pattern.inputMatch) {
      try {
        const regex = new RegExp(policy.pattern.inputMatch, 'i');
        if (!regex.test(toolInput)) continue;
      } catch {
        continue;
      }
    }
    if (policy.action === 'auto_allow') return null;
    if (policy.action === 'auto_deny') return { needsApproval: true, trustLevel: policy.trustLevel, reason: 'Auto-denied by policy' };
    return { needsApproval: true, trustLevel: policy.trustLevel, reason: 'Required by policy' };
  }

  // Check built-in dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (!toolName.includes(pattern.toolName)) continue;
    try {
      const regex = new RegExp(pattern.inputMatch, 'i');
      if (regex.test(toolInput)) {
        return { needsApproval: true, trustLevel: pattern.trustLevel, reason: pattern.reason };
      }
    } catch {
      continue;
    }
  }

  return null;
}

// --- Approval Request Management ---

export function createApprovalRequest(sessionId: string, toolName: string, toolInput: string, trustLevel: string, reason: string): ApprovalRequest {
  return {
    id: uuidv4(),
    sessionId,
    toolName,
    toolInput: toolInput.substring(0, 2000), // Truncate for display
    trustLevel,
    reason,
    timestamp: Date.now(),
  };
}

export function waitForApproval(approvalId: string, timeoutMs: number = 300000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false); // Auto-deny on timeout
    }, timeoutMs);

    pendingApprovals.set(approvalId, { resolve, timer });
  });
}

export function resolveApproval(approvalId: string, approved: boolean, alwaysAllow?: { toolName: string; inputMatch?: string }): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingApprovals.delete(approvalId);
  pending.resolve(approved);

  // If "always allow", add a policy
  if (approved && alwaysAllow) {
    const store = loadPolicies();
    store.policies.push({
      id: uuidv4(),
      pattern: { toolName: alwaysAllow.toolName, inputMatch: alwaysAllow.inputMatch },
      action: 'auto_allow',
      trustLevel: 'normal',
      createdAt: Date.now(),
    });
    savePolicies(store);
  }

  return true;
}

export function getPendingCount(): number {
  return pendingApprovals.size;
}
