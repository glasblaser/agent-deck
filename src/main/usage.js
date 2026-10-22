// Uso/limites por conta. Lê o token que a própria CLI salvou no diretório do perfil
// e consulta o mesmo endpoint que a CLI usa. O token nunca sai do processo principal,
// e nunca é renovado aqui: renovar rotaciona o refresh token e desloga a CLI.
//
// ATENÇÃO: os dois endpoints são internos (não documentados) e podem mudar sem aviso.
const fs = require('node:fs');
const path = require('node:path');
const { HOME } = require('./store');

const MIN_INTERVAL = 5 * 60 * 1000;
const FORCE_INTERVAL = 30 * 1000;
const BACKOFF_429 = 15 * 60 * 1000;
const cache = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const CLAUDE_LABELS = {
  five_hour: 'Sessão (5h)',
  seven_day: 'Semana',
  seven_day_opus: 'Semana · Opus',
  seven_day_sonnet: 'Semana · Sonnet',
};

async function claudeUsage(profile) {
  const creds = readJson(path.join(profile.dir, '.credentials.json'))?.claudeAiOauth;
  const config = readJson(profile.isDefault ? path.join(HOME, '.claude.json') : path.join(profile.dir, '.claude.json'));
  const base = { email: config?.oauthAccount?.emailAddress || null, plan: creds?.subscriptionType || null };
  if (!creds?.accessToken) return { ...base, status: 'nologin', message: 'Sem login. Abra o Claude nessa conta e faça /login.' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    return { ...base, status: 'expired', message: 'Token expirado. Abra o Claude nessa conta para renovar.' };
  }
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) return { ...base, status: 'error', rateLimited: true, message: 'Anthropic limitou a consulta. Tento de novo mais tarde.' };
  if (!res.ok) return { ...base, status: 'error', message: `Anthropic respondeu ${res.status}.` };
  const body = await res.json();
  const windows = Object.entries(body)
    .filter(([, v]) => v && typeof v === 'object' && typeof v.utilization === 'number')
    .map(([key, v]) => ({ label: CLAUDE_LABELS[key] || key, used: Math.max(0, Math.min(100, v.utilization)), resetsAt: v.resets_at || null }));
  return { ...base, status: 'ok', windows };
}

function windowLabel(seconds) {
  if (seconds >= 6 * 86400) return 'Semana';
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} dias`;
  return `Sessão (${Math.round(seconds / 3600)}h)`;
}

function jwtEmail(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload['https://api.openai.com/profile']?.email || null;
  } catch {
    return null;
  }
}

function codexWindows(out, prefix, limit) {
  for (const key of ['primary_window', 'secondary_window']) {
    const w = limit?.[key];
    if (!w || typeof w.used_percent !== 'number' || !(w.limit_window_seconds > 0)) continue;
    out.push({
      label: `${prefix}${windowLabel(w.limit_window_seconds)}`,
      used: Math.max(0, Math.min(100, w.used_percent)),
      resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
    });
  }
}

async function codexUsage(profile) {
  const tokens = readJson(path.join(profile.dir, 'auth.json'))?.tokens;
  const base = { email: tokens?.id_token ? jwtEmail(tokens.id_token) : null, plan: null };
  if (!tokens?.access_token) return { ...base, status: 'nologin', message: 'Sem login. Use "Login" nessa conta (codex login).' };
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 401) return { ...base, status: 'expired', message: 'Token expirado. Abra o Codex nessa conta para renovar.' };
  if (res.status === 429) return { ...base, status: 'error', rateLimited: true, message: 'OpenAI limitou a consulta. Tento de novo mais tarde.' };
  if (!res.ok) return { ...base, status: 'error', message: `OpenAI respondeu ${res.status}.` };
  const body = await res.json();
  const windows = [];
  codexWindows(windows, '', body.rate_limit);
  for (const extra of body.additional_rate_limits || []) {
    codexWindows(windows, extra.limit_name ? `${extra.limit_name} · ` : '', extra.rate_limit);
  }
  return { ...base, plan: body.plan_type || null, status: 'ok', windows };
}

async function forProfile(profile, force = false) {
  const hit = cache.get(profile.id);
  const now = Date.now();
  if (hit) {
    const wait = hit.result.rateLimited ? BACKOFF_429 : force ? FORCE_INTERVAL : MIN_INTERVAL;
    if (now - hit.at < wait) return hit.result;
  }
  let result;
  try {
    result = profile.kind === 'claude' ? await claudeUsage(profile) : await codexUsage(profile);
  } catch (error) {
    result = { status: 'error', message: `Falha ao consultar: ${error.message}` };
  }
  result.fetchedAt = new Date(now).toISOString();
  cache.set(profile.id, { at: now, result });
  return result;
}

module.exports = { forProfile };
