// What kind of failure was that? A signature per failure, so the runner can stop at the first one that only a person
// or the machine can fix (graphics card or computer out of memory, signed out, billing) instead of paying for the same failure
// again (T3: 4.0M tokens went to three sessions that all hit "CUDA error: out of memory").
export const SIGNATURES = [
  // the graphics card only when the text names it (CUDA, cuBLAS, VRAM); a plain "out of memory" is the computer's memory
  ['gpu', /cuda error|cuda out of memory|outofmemoryerror: cuda|cudamalloc|cublas_status_alloc|not enough free graphics memory|vram/i],
  // Node's heap ("JavaScript heap out of memory", "Reached heap limit") or the system's RAM (ENOMEM, OOM killer)
  ['memory', /javascript heap out of memory|reached heap limit|allocation failed|\benomem\b|cannot allocate memory|out of memory|\boom\b/i],
  // signed out: Claude Code's own words ("Please run /login", "Invalid API key", "OAuth token has expired"), never a
  // "/login" inside a URL or a path
  ['login', /oauth token|authenticat|\b401\b|(?:please )?run \/login|not logged in|logged out|signed out|unauthori[sz]ed|invalid api key|credentials? (?:expired|invalid)|session expired|token expired/i],
  ['billing', /billing|credit balance|insufficient (?:credit|fund|quota)|payment required|\b402\b|quota (?:exceeded|exhausted)|out of credits|plan limit/i],
  ['rate-limit', /rate.?limit|\b429\b|overloaded|too many requests|usage limit/i],
  ['stopped', /exited 143|exit(?:ed)? (?:code )?143|sigterm|sigkill|\bkilled\b|the studio was stopped|session time limit|^stopped$/i],
];

// Only a person or the machine can fix these: pause at the first one.
export const HARD = new Set(['gpu', 'memory', 'login', 'billing']);

export function failureSignature(...texts) {
  const s = texts.flat().filter(Boolean).join('\n');
  if (!s.trim()) return null;
  for (const [name, re] of SIGNATURES) if (re.test(s)) return name;
  return null;
}

const FIX = {
  gpu: 'The graphics card ran out of memory. Close what else is using it (the Models monitor shows who), then press Resume.',
  memory: 'The computer ran out of memory (RAM). Close what else is using it, then press Resume.',
  login: 'Claude Code is signed out. Link it again, then press Resume.',
  billing: 'A paid service refused the call (billing or credits). Check the account, then press Resume.',
  'rate-limit': 'The service said slow down. Press Resume in a few minutes.',
  stopped: 'The session was stopped. Press Resume to carry on.',
};

export const fixText = (sig) => FIX[sig] || '';
