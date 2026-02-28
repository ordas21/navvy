import * as cdp from './cdp.js';

export type CaptchaType = 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'image' | 'turnstile';

interface CaptchaDetection {
  type: CaptchaType;
  siteKey: string | null;
  elementSelector: string | null;
}

// --- CAPTCHA Detection ---

export async function detectCaptcha(): Promise<CaptchaDetection | null> {
  return cdp.evaluate<CaptchaDetection | null>(`
    (function() {
      // reCAPTCHA v2
      var recaptchaV2 = document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"]');
      if (recaptchaV2) {
        var siteKey = recaptchaV2.getAttribute('data-sitekey');
        if (!siteKey) {
          var iframe = document.querySelector('iframe[src*="recaptcha"]');
          if (iframe) {
            var match = iframe.src.match(/[?&]k=([^&]+)/);
            siteKey = match ? match[1] : null;
          }
        }
        return { type: 'recaptcha_v2', siteKey: siteKey, elementSelector: '.g-recaptcha' };
      }

      // reCAPTCHA v3 (invisible)
      var recaptchaV3 = document.querySelector('[data-sitekey][data-size="invisible"], script[src*="recaptcha/api.js?render="]');
      if (recaptchaV3) {
        var siteKey = recaptchaV3.getAttribute('data-sitekey');
        if (!siteKey) {
          var script = document.querySelector('script[src*="recaptcha/api.js?render="]');
          if (script) {
            var match = script.src.match(/render=([^&]+)/);
            siteKey = match ? match[1] : null;
          }
        }
        return { type: 'recaptcha_v3', siteKey: siteKey, elementSelector: null };
      }

      // hCaptcha
      var hcaptcha = document.querySelector('.h-captcha, [data-sitekey][data-hcaptcha], iframe[src*="hcaptcha"]');
      if (hcaptcha) {
        var siteKey = hcaptcha.getAttribute('data-sitekey');
        return { type: 'hcaptcha', siteKey: siteKey, elementSelector: '.h-captcha' };
      }

      // Cloudflare Turnstile
      var turnstile = document.querySelector('.cf-turnstile, [data-sitekey][data-appearance], iframe[src*="challenges.cloudflare"]');
      if (turnstile) {
        var siteKey = turnstile.getAttribute('data-sitekey');
        return { type: 'turnstile', siteKey: siteKey, elementSelector: '.cf-turnstile' };
      }

      return null;
    })()
  `);
}

// --- CAPTCHA Solving ---

interface SolveParams {
  type: CaptchaType;
  siteKey?: string;
  pageUrl: string;
  imageBase64?: string;
}

async function solveWithCapSolver(params: SolveParams): Promise<string> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error('CAPSOLVER_API_KEY environment variable not set');

  const taskTypeMap: Record<CaptchaType, string> = {
    recaptcha_v2: 'ReCaptchaV2TaskProxyLess',
    recaptcha_v3: 'ReCaptchaV3TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
    turnstile: 'AntiTurnstileTaskProxyLess',
    image: 'ImageToTextTask',
  };

  // Create task
  const createBody: Record<string, unknown> = {
    clientKey: apiKey,
    task: {
      type: taskTypeMap[params.type],
    },
  };

  if (params.type === 'image' && params.imageBase64) {
    (createBody.task as Record<string, unknown>).body = params.imageBase64;
  } else {
    const task = createBody.task as Record<string, unknown>;
    task.websiteURL = params.pageUrl;
    task.websiteKey = params.siteKey;
    if (params.type === 'recaptcha_v3') {
      task.pageAction = 'verify';
      task.minScore = 0.7;
    }
  }

  const createResponse = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createBody),
  });

  const createResult = await createResponse.json() as { errorId: number; taskId?: string; errorCode?: string; errorDescription?: string };
  if (createResult.errorId !== 0) {
    throw new Error(`CapSolver createTask failed: ${createResult.errorCode} — ${createResult.errorDescription}`);
  }

  const taskId = createResult.taskId!;

  // Poll for result
  const maxAttempts = 60;
  const pollInterval = 3000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const getResponse = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });

    const getResult = await getResponse.json() as {
      status: string;
      solution?: { gRecaptchaResponse?: string; token?: string; text?: string };
      errorCode?: string;
      errorDescription?: string;
    };

    if (getResult.status === 'ready') {
      const solution = getResult.solution;
      return solution?.gRecaptchaResponse || solution?.token || solution?.text || '';
    }

    if (getResult.status === 'failed') {
      throw new Error(`CapSolver task failed: ${getResult.errorCode} — ${getResult.errorDescription}`);
    }
  }

  throw new Error('CapSolver: timeout waiting for solution');
}

async function solveWith2Captcha(params: SolveParams): Promise<string> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) throw new Error('TWOCAPTCHA_API_KEY environment variable not set');

  const methodMap: Record<CaptchaType, string> = {
    recaptcha_v2: 'userrecaptcha',
    recaptcha_v3: 'userrecaptcha',
    hcaptcha: 'hcaptcha',
    turnstile: 'turnstile',
    image: 'base64',
  };

  const formData: Record<string, string> = {
    key: apiKey,
    method: methodMap[params.type],
    json: '1',
  };

  if (params.type === 'image' && params.imageBase64) {
    formData.body = params.imageBase64;
  } else {
    formData.pageurl = params.pageUrl;
    formData.googlekey = params.siteKey || '';
    if (params.type === 'hcaptcha') {
      formData.sitekey = params.siteKey || '';
    }
    if (params.type === 'recaptcha_v3') {
      formData.version = 'v3';
      formData.action = 'verify';
      formData.min_score = '0.7';
    }
  }

  const submitUrl = 'https://2captcha.com/in.php?' + new URLSearchParams(formData).toString();
  const submitResponse = await fetch(submitUrl);
  const submitResult = await submitResponse.json() as { status: number; request: string };

  if (submitResult.status !== 1) {
    throw new Error(`2Captcha submit failed: ${submitResult.request}`);
  }

  const captchaId = submitResult.request;

  // Poll for result
  const maxAttempts = 60;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const resultUrl = `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`;
    const resultResponse = await fetch(resultUrl);
    const result = await resultResponse.json() as { status: number; request: string };

    if (result.status === 1) {
      return result.request;
    }

    if (result.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha failed: ${result.request}`);
    }
  }

  throw new Error('2Captcha: timeout waiting for solution');
}

export async function solveCaptcha(params: SolveParams): Promise<string> {
  // Try CapSolver first, fall back to 2Captcha
  if (process.env.CAPSOLVER_API_KEY) {
    return solveWithCapSolver(params);
  }
  if (process.env.TWOCAPTCHA_API_KEY) {
    return solveWith2Captcha(params);
  }
  throw new Error('No CAPTCHA service configured. Set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY environment variable.');
}

// --- Inject Solution ---

export async function injectCaptchaSolution(type: CaptchaType, solution: string): Promise<void> {
  switch (type) {
    case 'recaptcha_v2':
    case 'recaptcha_v3':
      await cdp.evaluate(`
        (function() {
          var textarea = document.getElementById('g-recaptcha-response');
          if (!textarea) {
            textarea = document.querySelector('[name="g-recaptcha-response"]');
          }
          if (textarea) {
            textarea.value = ${JSON.stringify(solution)};
            textarea.style.display = 'block';
          }
          // Call the callback if defined
          if (typeof ___grecaptcha_cfg !== 'undefined') {
            var clients = ___grecaptcha_cfg.clients;
            if (clients) {
              for (var key in clients) {
                var client = clients[key];
                // Walk the client object to find the callback
                var stack = [client];
                while (stack.length) {
                  var obj = stack.pop();
                  if (!obj || typeof obj !== 'object') continue;
                  for (var k in obj) {
                    if (typeof obj[k] === 'function' && k.length === 2) {
                      try { obj[k](${JSON.stringify(solution)}); } catch(e) {}
                    }
                    if (typeof obj[k] === 'object') stack.push(obj[k]);
                  }
                }
              }
            }
          }
          // Also try window.grecaptcha.execute callback
          if (window.grecaptcha && window.grecaptcha.getResponse) {
            // Trigger form submit or callback
            var forms = document.querySelectorAll('form');
            forms.forEach(function(f) { f.dispatchEvent(new Event('submit', { bubbles: true })); });
          }
        })()
      `);
      break;

    case 'hcaptcha':
      await cdp.evaluate(`
        (function() {
          var textarea = document.querySelector('[name="h-captcha-response"], [name="g-recaptcha-response"]');
          if (textarea) textarea.value = ${JSON.stringify(solution)};
          // Try hcaptcha callback
          if (window.hcaptcha) {
            var iframes = document.querySelectorAll('iframe[data-hcaptcha-widget-id]');
            iframes.forEach(function(iframe) {
              var id = iframe.getAttribute('data-hcaptcha-widget-id');
              if (id && window.hcaptcha.getRespKey) {
                // Trigger callback
              }
            });
          }
        })()
      `);
      break;

    case 'turnstile':
      await cdp.evaluate(`
        (function() {
          var input = document.querySelector('[name="cf-turnstile-response"]');
          if (input) input.value = ${JSON.stringify(solution)};
          if (window.turnstile) {
            // Turnstile doesn't expose a direct callback setter
          }
        })()
      `);
      break;

    case 'image':
      // Image CAPTCHAs usually just need the text typed into an input
      // The caller should handle this
      break;
  }
}
