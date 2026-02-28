import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

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

// --- Built-in dangerous patterns ---

const DANGEROUS_PATTERNS: Array<{ toolName: string; inputMatch: string; trustLevel: 'dangerous' | 'sensitive'; reason: string }> = [
  { toolName: 'system_shell', inputMatch: 'git push|rm -rf|sudo|shutdown|reboot', trustLevel: 'dangerous', reason: 'Destructive system command' },
  { toolName: 'browser_click', inputMatch: 'purchase|buy|checkout|pay|submit.*payment', trustLevel: 'dangerous', reason: 'Potential purchase action' },
  { toolName: 'browser_fill_form', inputMatch: 'credit.?card|cvv|ssn', trustLevel: 'dangerous', reason: 'Sensitive financial data entry' },
  { toolName: 'system_shell', inputMatch: 'curl.*\\|.*sh|wget.*\\|.*sh', trustLevel: 'dangerous', reason: 'Remote code execution pattern' },
  { toolName: 'system_kill_process', inputMatch: '.*', trustLevel: 'sensitive', reason: 'Process termination' },
  { toolName: 'system_write_file', inputMatch: '\\.env|credentials|secret|password|token', trustLevel: 'sensitive', reason: 'Writing to sensitive file' },
];

// --- Pending approvals (in-memory) ---

const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// --- DB Helpers ---

interface PolicyRow {
  id: string;
  pattern: string;
  action: string;
  trust_level: string;
  created_at: number;
}

function rowToPolicy(row: PolicyRow): ApprovalPolicy {
  return {
    id: row.id,
    pattern: JSON.parse(row.pattern),
    action: row.action as ApprovalPolicy['action'],
    trustLevel: row.trust_level as ApprovalPolicy['trustLevel'],
    createdAt: row.created_at,
  };
}

// --- Storage ---

export function loadPolicies(): PolicyStore {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM approval_policies ORDER BY created_at ASC').all() as PolicyRow[];
  return { version: 1, policies: rows.map(rowToPolicy) };
}

export function savePolicies(store: PolicyStore): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM approval_policies').run();
    const insert = db.prepare(`
      INSERT INTO approval_policies (id, pattern, action, trust_level, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of store.policies) {
      insert.run(p.id, JSON.stringify(p.pattern), p.action, p.trustLevel, p.createdAt);
    }
  });
  tx();
}

// --- Policy Matching ---

export function checkApproval(toolName: string, toolInput: string, _hostname?: string): { needsApproval: boolean; trustLevel: string; reason: string } | null {
  const store = loadPolicies();

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
    toolInput: toolInput.substring(0, 2000),
    trustLevel,
    reason,
    timestamp: Date.now(),
  };
}

export function waitForApproval(approvalId: string, timeoutMs: number = 300000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      resolve(false);
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

  if (approved && alwaysAllow) {
    const db = getDb();
    db.prepare(`
      INSERT INTO approval_policies (id, pattern, action, trust_level, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      JSON.stringify({ toolName: alwaysAllow.toolName, inputMatch: alwaysAllow.inputMatch }),
      'auto_allow',
      'normal',
      Date.now(),
    );
  }

  return true;
}

export function getPendingCount(): number {
  return pendingApprovals.size;
}
