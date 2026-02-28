import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CredentialProvider = '1password' | 'bitwarden' | 'env' | 'keychain';

interface CredentialRef {
  token: string;
  provider: CredentialProvider;
  lookupKey: string;
  field: string;
  createdAt: number;
}

// In-memory map of active tokens (never persisted to disk)
const activeRefs = new Map<string, CredentialRef>();

// TTL for credential references: 5 minutes
const TTL_MS = 5 * 60 * 1000;

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, ref] of activeRefs) {
    if (now - ref.createdAt > TTL_MS) {
      activeRefs.delete(token);
    }
  }
}, 60000);

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function createCredentialRef(provider: CredentialProvider, lookupKey: string, field: string): string {
  const token = `{{cred:${generateToken()}}}`;
  activeRefs.set(token, {
    token,
    provider,
    lookupKey,
    field,
    createdAt: Date.now(),
  });
  return token;
}

export async function resolveCredentialRef(token: string): Promise<string> {
  const ref = activeRefs.get(token);
  if (!ref) {
    throw new Error('Credential reference expired or not found');
  }

  // Check TTL
  if (Date.now() - ref.createdAt > TTL_MS) {
    activeRefs.delete(token);
    throw new Error('Credential reference expired');
  }

  // Resolve the actual credential
  const value = await fetchCredential(ref.provider, ref.lookupKey, ref.field);

  // Remove after use (single-use)
  activeRefs.delete(token);

  return value;
}

export function isCredentialToken(value: string): boolean {
  return /^\{\{cred:[a-z0-9]+\}\}$/.test(value);
}

async function fetchCredential(provider: CredentialProvider, lookupKey: string, field: string): Promise<string> {
  switch (provider) {
    case '1password': {
      try {
        const { stdout } = await execFileAsync('op', [
          'item', 'get', lookupKey,
          '--fields', field,
          '--format', 'json',
        ], { timeout: 15000 });
        const parsed = JSON.parse(stdout.trim());
        return parsed.value || parsed;
      } catch (err) {
        throw new Error(`1Password lookup failed: ${(err as Error).message}. Is 'op' CLI installed and signed in?`);
      }
    }

    case 'bitwarden': {
      try {
        if (field === 'password') {
          const { stdout } = await execFileAsync('bw', ['get', 'password', lookupKey], { timeout: 15000 });
          return stdout.trim();
        }
        if (field === 'username') {
          const { stdout } = await execFileAsync('bw', ['get', 'username', lookupKey], { timeout: 15000 });
          return stdout.trim();
        }
        // For other fields, get the full item
        const { stdout } = await execFileAsync('bw', ['get', 'item', lookupKey], { timeout: 15000 });
        const item = JSON.parse(stdout.trim());
        // Check custom fields
        const customField = item.fields?.find((f: { name: string; value: string }) => f.name === field);
        if (customField) return customField.value;
        // Check login fields
        if (item.login?.[field]) return item.login[field];
        throw new Error(`Field "${field}" not found in Bitwarden item "${lookupKey}"`);
      } catch (err) {
        throw new Error(`Bitwarden lookup failed: ${(err as Error).message}. Is 'bw' CLI installed and unlocked?`);
      }
    }

    case 'env': {
      const value = process.env[lookupKey];
      if (!value) {
        throw new Error(`Environment variable "${lookupKey}" not set`);
      }
      return value;
    }

    case 'keychain': {
      try {
        const { stdout } = await execFileAsync('security', [
          'find-generic-password',
          '-s', lookupKey,
          '-w',
        ], { timeout: 10000 });
        return stdout.trim();
      } catch (err) {
        throw new Error(`macOS Keychain lookup failed: ${(err as Error).message}`);
      }
    }

    default:
      throw new Error(`Unknown credential provider: ${provider}`);
  }
}
