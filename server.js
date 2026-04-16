const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// metatadata url: 
// Keycloak OIDC config
const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'https://login.asp.messina.it';
const REALM = process.env.REALM || 'asp';
const CLIENT_ID = process.env.CLIENT_ID || 'spid-test-login';

// BASE_PATH per il reverse proxy di ws1.asp.messina.it
const BASE_PATH = process.env.BASE_PATH || '';

// URL pubblica dell'app (calcolata dal BASE_PATH o impostata manualmente)
const APP_URL = process.env.APP_URL || (BASE_PATH
  ? `https://ws1.asp.messina.it${BASE_PATH}`
  : `http://localhost:${PORT}`);

// Session - sameSite: 'none' necessario per i POST cross-site dal validatore SPID
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'spid-test-login-asp-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: APP_URL.startsWith('https'),
    httpOnly: true,
    sameSite: APP_URL.startsWith('https') ? 'none' : 'lax',
    maxAge: 30 * 60 * 1000 // 30 minuti
  }
}));

// Middleware per iniettare BASE_PATH nelle risposte
app.use((req, res, next) => {
  res.locals.basePath = BASE_PATH;
  res.locals.appUrl = APP_URL;
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

let oidcClient;

async function initOIDC() {
  try {
    const issuer = await Issuer.discover(`${KEYCLOAK_URL}/realms/${REALM}`);
    console.log('OIDC Issuer discovered:', issuer.issuer);

    oidcClient = new issuer.Client({
      client_id: CLIENT_ID,
      redirect_uris: [`${APP_URL}/callback`],
      response_types: ['code'],
      token_endpoint_auth_method: 'none' // public client
    });

    console.log('OIDC Client configured:', CLIENT_ID);
  } catch (err) {
    console.error('Errore inizializzazione OIDC:', err.message);
    console.log('Ritento tra 5 secondi...');
    await new Promise(r => setTimeout(r, 5000));
    return initOIDC();
  }
}

// ---- ROUTES ----

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: configurazione app (usata dal frontend per conoscere BASE_PATH e stato)
app.get('/api/config', (req, res) => {
  res.json({
    basePath: BASE_PATH,
    appUrl: APP_URL,
    keycloakUrl: KEYCLOAK_URL,
    realm: REALM,
    clientId: CLIENT_ID,
    authenticated: !!req.session.user
  });
});

// Login - redirect a Keycloak con SPID forzato
app.get('/login', (req, res) => {
  if (!oidcClient) return res.status(503).send('OIDC non inizializzato');

  const nonce = generators.nonce();
  const state = generators.state();
  req.session.nonce = nonce;
  req.session.state = state;

  const params = {
    scope: 'openid profile email spid-cie-attributes',
    nonce,
    state,
    redirect_uri: `${APP_URL}/callback`
  };

  // Se viene specificato un IdP, forzalo (es. ?idp=spid-idp-posteid per login diretto)
  if (req.query.idp) {
    params.kc_idp_hint = req.query.idp;
  }
  // Altrimenti Keycloak mostra la pagina di login con i metodi configurati
  // (il tema legge l'attributo login_methods del client e mostra solo SPID)

  const authUrl = oidcClient.authorizationUrl(params);
  res.redirect(authUrl);
});

// Callback da Keycloak dopo autenticazione
app.get('/callback', async (req, res) => {
  try {
    if (!oidcClient) return res.status(503).send('OIDC non inizializzato');

    const params = oidcClient.callbackParams(req);

    // Keycloak restituisce error + error_description quando l'autenticazione SPID fallisce
    // (es. utente annulla, credenziali errate, identità sospesa, consenso negato)
    if (params.error) {
      console.warn(`[SPID] Errore OIDC ricevuto: ${params.error} - ${params.error_description || 'nessuna descrizione'}`);
      const errorParams = new URLSearchParams({
        error: params.error,
        error_description: params.error_description || '',
        msg: params.error_description || params.error
      });
      return res.redirect(`${BASE_PATH}/error?${errorParams.toString()}`);
    }

    // Build checks: include state/nonce solo se presenti in sessione
    const checks = {};
    if (req.session.nonce) checks.nonce = req.session.nonce;
    if (req.session.state) checks.state = req.session.state;

    let tokenSet;
    try {
      tokenSet = await oidcClient.callback(`${APP_URL}/callback`, params, checks);
    } catch (validationErr) {
      // Se la validazione state/nonce fallisce (tipico con SPID validator
      // che fa POST cross-site e i cookie di sessione non arrivano),
      // usiamo grant() per scambiare il code senza validazione OIDC strict
      console.warn('[SPID] Validazione OIDC fallita, uso grant diretto:', validationErr.message);
      tokenSet = await oidcClient.grant({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: `${APP_URL}/callback`
      });
    }

    console.log('[CALLBACK] Token ottenuto, claims:', JSON.stringify(tokenSet.claims(), null, 2));

    // Decodifica ID token per debug
    let idTokenDecoded = {};
    if (tokenSet.id_token) {
      try {
        const parts = tokenSet.id_token.split('.');
        idTokenDecoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('[CALLBACK] ID Token decoded:', JSON.stringify(idTokenDecoded, null, 2));
      } catch (e) {
        console.warn('[CALLBACK] Errore decode ID token:', e.message);
      }
    }

    // Decodifica Access token per debug
    let accessTokenDecoded = {};
    if (tokenSet.access_token) {
      try {
        const parts = tokenSet.access_token.split('.');
        accessTokenDecoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        console.log('[CALLBACK] Access Token decoded:', JSON.stringify(accessTokenDecoded, null, 2));
      } catch (e) {
        console.warn('[CALLBACK] Errore decode Access token:', e.message);
      }
    }

    // Userinfo - con fallback se endpoint non risponde JSON valido
    let userinfo = {};
    try {
      userinfo = await oidcClient.userinfo(tokenSet.access_token);
      console.log('[CALLBACK] Userinfo:', JSON.stringify(userinfo, null, 2));
    } catch (userinfoErr) {
      console.error('[CALLBACK] Errore userinfo (fallback a token claims):', userinfoErr.message);
      // Fallback: usiamo i claims dal token stesso
      userinfo = tokenSet.claims() || idTokenDecoded;
    }

    // Merge tutti i dati: userinfo + claims ID token (per avere tutto)
    const mergedUser = { ...idTokenDecoded, ...userinfo };

    req.session.user = mergedUser;
    req.session.tokenSet = {
      access_token: tokenSet.access_token,
      id_token: tokenSet.id_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: tokenSet.expires_at
    };
    req.session.loginTime = new Date().toISOString();
    req.session.debug = {
      idTokenClaims: idTokenDecoded,
      accessTokenClaims: accessTokenDecoded,
      userinfo: userinfo
    };

    console.log(`[CALLBACK] Utente autenticato: ${mergedUser.preferred_username || mergedUser.sub} (${Object.keys(mergedUser).length} attributi)`);

    // Salva in sessione (per accesso successivo via /profile)
    req.session.save((err) => {
      if (err) console.error('Errore salvataggio sessione:', err);
      renderProfile(req, res, mergedUser, new Date().toISOString());
    });
  } catch (err) {
    console.error('[CALLBACK] Errore completo:', err);
    res.redirect(`${BASE_PATH}/error?msg=${encodeURIComponent(err.message)}`);
  }
});

// ============================================================
// Mappa errori SPID AGID v1.4
// Codici 19-25: anomalie utente (ricevuti dal SP via SAML StatusCode)
// Codici 8-18: anomalie AuthnRequest (errori tecnici SP)
// Codici 26-30: riuso identità pregresse
// ============================================================
const SPID_ERRORS = {
  // --- Errori utente (19-25) ---
  '19': {
    title: 'Autenticazione non riuscita',
    desc: 'Le credenziali inserite non sono corrette oppure il numero massimo di tentativi è stato superato. Si prega di riprovare o contattare il proprio Identity Provider SPID.',
    icon: '&#128274;', color: '#dc2626', category: 'utente'
  },
  '20': {
    title: 'Sessione scaduta',
    desc: 'Il tempo a disposizione per completare l\'autenticazione è scaduto. Si prega di riprovare.',
    icon: '&#9200;', color: '#d97706', category: 'utente'
  },
  '21': {
    title: 'Consenso negato',
    desc: 'L\'utente ha negato il consenso all\'invio dei dati al Service Provider. Per accedere al servizio è necessario acconsentire alla trasmissione degli attributi richiesti.',
    icon: '&#128683;', color: '#d97706', category: 'utente'
  },
  '22': {
    title: 'Identità sospesa o revocata',
    desc: 'L\'identità digitale SPID risulta sospesa o revocata. Si prega di contattare il proprio Identity Provider per verificare lo stato della propria identità.',
    icon: '&#9888;', color: '#dc2626', category: 'utente'
  },
  '23': {
    title: 'Operazione annullata dall\'utente',
    desc: 'L\'utente ha annullato l\'operazione di autenticazione. È possibile riprovare quando si desidera.',
    icon: '&#10060;', color: '#6b7280', category: 'utente'
  },
  '25': {
    title: 'Processo di autenticazione annullato',
    desc: 'Il processo di autenticazione è stato annullato. Si prega di riprovare.',
    icon: '&#10060;', color: '#6b7280', category: 'utente'
  },
  // --- Errori tecnici SP (8-18) ---
  '8': { title: 'Errore nella richiesta di autenticazione', desc: 'La richiesta di autenticazione presenta delle anomalie. Si prega di riprovare.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '9': { title: 'Errore nella richiesta di autenticazione', desc: 'La richiesta di autenticazione presenta delle anomalie nel formato.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '11': { title: 'Errore nella richiesta di autenticazione', desc: 'Attributo obbligatorio mancante nella richiesta.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '12': { title: 'Errore nella richiesta di autenticazione', desc: 'Errore nel formato degli attributi della richiesta.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '13': { title: 'Errore nella richiesta di autenticazione', desc: 'Richiesta non conforme alle specifiche SAML.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '14': { title: 'Errore nella richiesta di autenticazione', desc: 'Binding della richiesta non supportato.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '15': { title: 'Errore nella richiesta di autenticazione', desc: 'Errore nella validazione della firma della richiesta.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '16': { title: 'Errore nella richiesta di autenticazione', desc: 'Richiesta troppo vecchia o con validità temporale non corretta.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '17': { title: 'Errore nella richiesta di autenticazione', desc: 'Il Service Provider non è registrato presso l\'Identity Provider.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  '18': { title: 'Errore nella richiesta di autenticazione', desc: 'Errore nel set di attributi richiesti dal Service Provider.', icon: '&#128295;', color: '#dc2626', category: 'tecnico' },
  // --- Riuso identità pregresse (26-30) ---
  '26': { title: 'Errore nel processo di riuso identità', desc: 'Errore nel processo di autenticazione con identità pregressa.', icon: '&#128295;', color: '#dc2626', category: 'riuso' },
  '27': { title: 'Errore nel processo di riuso identità', desc: 'Errore nel processo di autenticazione con identità pregressa.', icon: '&#128295;', color: '#dc2626', category: 'riuso' },
  '28': { title: 'Errore nel processo di riuso identità', desc: 'Errore nel processo di autenticazione con identità pregressa.', icon: '&#128295;', color: '#dc2626', category: 'riuso' },
  '29': { title: 'Errore nel processo di riuso identità', desc: 'Errore nel processo di autenticazione con identità pregressa.', icon: '&#128295;', color: '#dc2626', category: 'riuso' },
  '30': { title: 'Errore nel processo di riuso identità', desc: 'Errore nel processo di autenticazione con identità pregressa.', icon: '&#128295;', color: '#dc2626', category: 'riuso' }
};

// Rileva il codice errore SPID dal messaggio di errore o dalla descrizione
function detectSpidError(msg, errorCode, errorDesc) {
  const fullText = `${msg || ''} ${errorCode || ''} ${errorDesc || ''}`.toLowerCase();

  // Pattern matching per codici errore SPID noti
  // Il spid-keycloak-provider o l'IdP possono includere il numero nel StatusMessage
  const codeMatch = fullText.match(/(?:errore|error|codice|code|nr|anomalia)\s*[:\s#]?\s*(\d{1,2})/);
  if (codeMatch && SPID_ERRORS[codeMatch[1]]) {
    return { code: codeMatch[1], ...SPID_ERRORS[codeMatch[1]] };
  }

  // Pattern matching per parole chiave
  if (/authnfailed|autenticazione fallita|credenziali|authentication failed|wrong password/.test(fullText)) {
    return { code: '19', ...SPID_ERRORS['19'] };
  }
  if (/timeout|scadut|session expired|tempo/.test(fullText)) {
    return { code: '20', ...SPID_ERRORS['20'] };
  }
  if (/consent|consenso|denied|negat/.test(fullText)) {
    return { code: '21', ...SPID_ERRORS['21'] };
  }
  if (/sospes|revocat|suspended|revoked|bloccat/.test(fullText)) {
    return { code: '22', ...SPID_ERRORS['22'] };
  }
  if (/annullat|cancel|abort|interrott|user.cancel/.test(fullText)) {
    return { code: '23', ...SPID_ERRORS['23'] };
  }
  if (/access_denied/.test(fullText)) {
    return { code: '21', ...SPID_ERRORS['21'] };
  }
  if (/login_required|interaction_required/.test(fullText)) {
    return { code: '20', ...SPID_ERRORS['20'] };
  }

  return null; // Errore generico, non SPID-specifico
}

// Error page - mostra errore SPID AGID v1.4 con opzioni di recupero
app.get('/error', (req, res) => {
  const msg = req.query.msg || 'Errore sconosciuto';
  const errorCode = req.query.error || '';
  const errorDesc = req.query.error_description || '';
  const sanitize = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const spidError = detectSpidError(msg, errorCode, errorDesc);

  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Errore - ASP Messina SPID Test</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Titillium Web', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f8; color: #1e293b; min-height: 100vh; }
    .header { background: linear-gradient(135deg, ${spidError ? spidError.color : '#dc2626'}, #991b1b); color: white; padding: 25px 20px; text-align: center; }
    .header h1 { font-size: 1.3em; margin-bottom: 4px; }
    .container { max-width: 550px; margin: 30px auto; padding: 0 20px; }
    .error-icon { text-align: center; font-size: 48px; margin: 10px 0; }
    .error-title { text-align: center; font-size: 1.2em; font-weight: 700; margin-bottom: 6px; }
    .error-badge { display: inline-block; background: ${spidError ? spidError.color : '#dc2626'}; color: #fff; font-size: 0.75em; font-weight: 700; padding: 2px 10px; border-radius: 12px; margin-bottom: 12px; }
    .error-box { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; }
    .error-box p { color: #7f1d1d; font-size: 0.95em; line-height: 1.5; }
    .card { background: white; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 20px; }
    .card h3 { margin-bottom: 15px; color: #334155; font-size: 1em; }
    .btn { display: block; width: 100%; padding: 14px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 1em; text-align: center; margin-bottom: 10px; transition: all 0.2s; }
    .btn:last-child { margin-bottom: 0; }
    .btn-retry { background: #0066cc; color: white; }
    .btn-retry:hover { background: #004999; }
    .btn-reset { background: #dc2626; color: white; }
    .btn-reset:hover { background: #b91c1c; }
    .btn-home { background: #64748b; color: white; }
    .btn-home:hover { background: #475569; }
    .hint { margin-top: 16px; padding: 14px; background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; font-size: 0.85em; color: #1e40af; line-height: 1.5; }
    .hint strong { display: block; margin-bottom: 4px; }
    details { margin-bottom: 16px; }
    summary { cursor: pointer; color: #64748b; font-size: 0.8em; font-weight: 600; }
    .tech-detail { margin-top: 8px; padding: 10px; background: #f1f5f9; border-radius: 6px; font-size: 0.8em; color: #475569; word-break: break-word; font-family: monospace; }
  </style>
</head>
<body>
  <div class="header">
    <h1>ASP Messina - Errore Autenticazione SPID</h1>
  </div>
  <div class="container">
    ${spidError ? `
    <div class="error-icon">${spidError.icon}</div>
    <div style="text-align:center;">
      <div class="error-title" style="color:${spidError.color};">${sanitize(spidError.title)}</div>
      <span class="error-badge">Codice errore SPID: ${sanitize(spidError.code)}</span>
    </div>
    <div class="error-box">
      <p>${sanitize(spidError.desc)}</p>
    </div>
    ` : `
    <div class="error-icon">&#9888;</div>
    <div style="text-align:center;">
      <div class="error-title" style="color:#dc2626;">Errore durante l'autenticazione</div>
    </div>
    <div class="error-box">
      <p>${sanitize(msg)}</p>
    </div>
    `}

    <details>
      <summary>Dettaglio tecnico</summary>
      <div class="tech-detail">
        ${errorCode ? `<div><strong>Error:</strong> ${sanitize(errorCode)}</div>` : ''}
        ${errorDesc ? `<div><strong>Descrizione:</strong> ${sanitize(errorDesc)}</div>` : ''}
        <div><strong>Messaggio:</strong> ${sanitize(msg)}</div>
        <div><strong>Timestamp:</strong> ${new Date().toISOString()}</div>
      </div>
    </details>

    <div class="card">
      <h3>Cosa puoi fare:</h3>
      <a href="${BASE_PATH}/login" class="btn btn-retry">Riprova autenticazione</a>
      <a href="${BASE_PATH}/reset" class="btn btn-reset">Reset sessione e Logout</a>
      <a href="${BASE_PATH}/" class="btn btn-home">Torna alla Home</a>
    </div>

    ${spidError && (spidError.code === '19' || spidError.code === '22') ? `
    <div class="hint">
      <strong>Assistenza SPID</strong>
      Per problemi con le credenziali o lo stato dell'identità digitale,
      contattare il proprio Identity Provider SPID o visitare
      <a href="https://www.spid.gov.it/serve-aiuto" target="_blank">spid.gov.it/serve-aiuto</a>
    </div>` : ''}

    ${spidError && spidError.category === 'tecnico' ? `
    <div class="hint">
      <strong>Errore tecnico</strong>
      Questo errore indica un problema nella configurazione del Service Provider.
      Il team tecnico ASP Messina è stato notificato. Se il problema persiste,
      contattare l'assistenza tecnica.
    </div>` : ''}

    ${!spidError ? `
    <div class="hint">
      <strong>Suggerimento</strong>
      Se l'errore riguarda "state" o "nonce", premi "Reset sessione" per pulire tutto
      e poi riprova. Questo errore può capitare durante i test con il validatore SPID AgID.
    </div>` : ''}
  </div>
</body>
</html>`);
});

// Reset - pulisce la sessione locale e fa logout da Keycloak (sblocca lo stallo)
app.get('/reset', (req, res) => {
  req.session.destroy(() => {
    const logoutUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout?post_logout_redirect_uri=${encodeURIComponent(APP_URL)}&client_id=${CLIENT_ID}`;
    res.redirect(logoutUrl);
  });
});

// Funzione helper per renderizzare il profilo utente
// (usata sia da /callback che da /profile per evitare problemi di sessione cross-tab)
function renderProfile(req, res, user, loginTime) {
  const debug = req.session?.debug || null;
  const spidAttributes = {
    'sub': 'ID Utente (sub)',
    'preferred_username': 'Username',
    'given_name': 'Nome',
    'family_name': 'Cognome',
    'name': 'Nome Completo',
    'email': 'Email',
    'email_verified': 'Email Verificata',
    'fiscal_number': 'Codice Fiscale',
    'fiscalNumber': 'Codice Fiscale',
    'date_of_birth': 'Data di Nascita',
    'dateOfBirth': 'Data di Nascita',
    'place_of_birth': 'Luogo di Nascita',
    'placeOfBirth': 'Luogo di Nascita',
    'gender': 'Sesso',
    'mobile_phone': 'Telefono',
    'mobilePhone': 'Telefono',
    'address': 'Indirizzo',
    'spid_code': 'Codice SPID',
    'spidCode': 'Codice SPID'
  };

  const attributeRows = Object.entries(user).map(([key, value]) => {
    const label = spidAttributes[key] || key;
    const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    return `
      <tr>
        <td class="attr-key">${label}</td>
        <td class="attr-raw-key"><code>${key}</code></td>
        <td class="attr-value">${displayValue}</td>
      </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Profilo SPID - ASP Messina Test</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Titillium Web', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f8; color: #1e293b; }
    .header { background: linear-gradient(135deg, #0066cc, #004999); color: white; padding: 24px 20px; text-align: center; }
    .header h1 { font-size: 1.3em; margin-bottom: 4px; }
    .header p { opacity: 0.85; font-size: 0.9em; }
    .container { max-width: 800px; margin: 24px auto; padding: 0 16px; }
    .success-banner { background: #dcfce7; border: 1px solid #86efac; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
    .success-banner .icon { font-size: 1.5em; }
    .success-banner .text h3 { color: #166534; font-size: 1em; }
    .success-banner .text p { color: #15803d; font-size: 0.85em; margin-top: 2px; }
    .card { background: white; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 20px; overflow: hidden; }
    .card-header { background: #f8fafc; padding: 14px 20px; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: #0066cc; font-size: 0.95em; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; font-size: 0.9em; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .attr-key { font-weight: 600; color: #334155; width: 180px; }
    .attr-raw-key { color: #94a3b8; width: 160px; font-size: 0.8em; }
    .attr-value { color: #1e293b; word-break: break-all; }
    .actions { text-align: center; margin: 24px 0; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn { display: inline-block; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.95em; transition: all 0.2s; border: none; cursor: pointer; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-outline { background: white; color: #0066cc; border: 2px solid #0066cc; }
    .btn-outline:hover { background: #eff6ff; }
    .json-toggle { background: #f8fafc; padding: 14px 20px; border-top: 1px solid #e2e8f0; cursor: pointer; color: #0066cc; font-weight: 600; font-size: 0.9em; }
    .json-content { display: none; padding: 16px; background: #1e293b; color: #e2e8f0; font-family: 'Fira Code', monospace; font-size: 0.8em; overflow-x: auto; white-space: pre-wrap; }
    .json-content.open { display: block; }
    .badge { display: inline-block; background: #0066cc; color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; margin-left: 8px; }
    .badge-test { background: #f59e0b; }
    .footer { text-align: center; padding: 20px; color: #94a3b8; font-size: 0.8em; }
    @media (max-width: 600px) {
      .attr-raw-key { display: none; }
      .attr-key { width: 120px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>ASP Messina - Test Autenticazione SPID <span class="badge badge-test">TEST</span></h1>
    <p>Collaudo per certificazione AGID</p>
  </div>
  <div class="container">
    <div class="success-banner">
      <div class="icon">&#9989;</div>
      <div class="text">
        <h3>Autenticazione SPID completata con successo</h3>
        <p>Login effettuato il ${loginTime ? new Date(loginTime).toLocaleString('it-IT') : 'N/A'} tramite Keycloak OIDC</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header">Attributi SPID ricevuti <span class="badge">${Object.keys(user).length} attributi</span></div>
      <table>${attributeRows}</table>
      <div class="json-toggle" onclick="document.getElementById('json-raw').classList.toggle('open'); this.textContent = document.getElementById('json-raw').classList.contains('open') ? '&#9650; Chiudi JSON grezzo' : '&#9660; Mostra JSON grezzo';">
        &#9660; Mostra JSON grezzo
      </div>
      <div id="json-raw" class="json-content">${JSON.stringify(user, null, 2)}</div>
    </div>
    ${debug ? `
    <div class="card">
      <div class="card-header">Debug Token - ID Token Claims</div>
      <div class="json-toggle" onclick="document.getElementById('json-idtoken').classList.toggle('open'); this.textContent = document.getElementById('json-idtoken').classList.contains('open') ? '&#9650; Chiudi' : '&#9660; Mostra ID Token Claims';">
        &#9660; Mostra ID Token Claims
      </div>
      <div id="json-idtoken" class="json-content">${JSON.stringify(debug.idTokenClaims, null, 2)}</div>
    </div>
    <div class="card">
      <div class="card-header">Debug Token - Access Token Claims</div>
      <div class="json-toggle" onclick="document.getElementById('json-accesstoken').classList.toggle('open'); this.textContent = document.getElementById('json-accesstoken').classList.contains('open') ? '&#9650; Chiudi' : '&#9660; Mostra Access Token Claims';">
        &#9660; Mostra Access Token Claims
      </div>
      <div id="json-accesstoken" class="json-content">${JSON.stringify(debug.accessTokenClaims, null, 2)}</div>
    </div>
    <div class="card">
      <div class="card-header">Debug Token - Userinfo Endpoint</div>
      <div class="json-toggle" onclick="document.getElementById('json-userinfo').classList.toggle('open'); this.textContent = document.getElementById('json-userinfo').classList.contains('open') ? '&#9650; Chiudi' : '&#9660; Mostra Userinfo';">
        &#9660; Mostra Userinfo
      </div>
      <div id="json-userinfo" class="json-content">${JSON.stringify(debug.userinfo, null, 2)}</div>
    </div>
    ` : ''}
    <div class="card">
      <div class="card-header">Dettagli Tecnici</div>
      <table>
        <tr><td class="attr-key">Keycloak URL</td><td class="attr-value">${KEYCLOAK_URL}</td></tr>
        <tr><td class="attr-key">Realm</td><td class="attr-value">${REALM}</td></tr>
        <tr><td class="attr-key">Client ID</td><td class="attr-value">${CLIENT_ID}</td></tr>
        <tr><td class="attr-key">Protocollo</td><td class="attr-value">OpenID Connect (Authorization Code Flow)</td></tr>
        <tr><td class="attr-key">Entity ID (SAML SP)</td><td class="attr-value">${KEYCLOAK_URL}/realms/${REALM}</td></tr>
        <tr><td class="attr-key">SPID Metadata</td><td class="attr-value"><a href="${KEYCLOAK_URL}/realms/${REALM}/spid-sp-metadata" target="_blank">${KEYCLOAK_URL}/realms/${REALM}/spid-sp-metadata</a></td></tr>
      </table>
    </div>
    <div class="actions">
      <a href="${BASE_PATH}/logout" class="btn btn-danger">Logout</a>
      <a href="${BASE_PATH}/" class="btn btn-outline">Torna alla Home</a>
      <a href="${BASE_PATH}/api/user" class="btn btn-outline" target="_blank">API JSON</a>
      <a href="${BASE_PATH}/api/userinfo" class="btn btn-outline" target="_blank" style="background:#f59e0b;color:#000;border-color:#f59e0b;">Test Userinfo KC</a>
    </div>
  </div>
  <div class="footer">
    ASP Messina &mdash; Test SPID per collaudo AGID | Client: ${CLIENT_ID}
  </div>
</body>
</html>`);
}

// Profilo utente - mostra gli attributi SPID dalla sessione
app.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect(`${BASE_PATH}/`);
  renderProfile(req, res, req.session.user, req.session.loginTime);
});

// API: test diretto userinfo endpoint Keycloak (simula la chiamata del client)
app.get('/api/userinfo', async (req, res) => {
  if (!req.session.tokenSet?.access_token) {
    return res.status(401).json({ error: 'Non autenticato', login_url: `${BASE_PATH}/login` });
  }

  const userinfoUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/userinfo`;
  const accessToken = req.session.tokenSet.access_token;

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(userinfoUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();

    // Prova a parsare come JSON
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      parseError = e.message;
    }

    // Se è un JWT (application/jwt), decodifica il payload
    let jwtDecoded = null;
    if (contentType.includes('jwt') || (!parsed && rawBody.split('.').length === 3)) {
      try {
        const parts = rawBody.split('.');
        jwtDecoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      } catch (e) {
        // non è un JWT valido
      }
    }

    res.json({
      endpoint: userinfoUrl,
      httpStatus: response.status,
      contentType: contentType,
      rawBodyLength: rawBody.length,
      rawBodyPreview: rawBody.substring(0, 500),
      isJson: !!parsed,
      isJwt: !!jwtDecoded,
      parseError: parseError,
      parsedJson: parsed,
      jwtDecoded: jwtDecoded
    });
  } catch (err) {
    // Fallback senza node-fetch: usa http nativo
    const https = require('https');
    const url = new URL(userinfoUrl);

    const proxyReq = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      rejectUnauthorized: false
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        const contentType = proxyRes.headers['content-type'] || '';
        let parsed = null, parseError = null, jwtDecoded = null;

        try { parsed = JSON.parse(data); } catch (e) { parseError = e.message; }

        if (contentType.includes('jwt') || (!parsed && data.split('.').length === 3)) {
          try {
            const parts = data.split('.');
            jwtDecoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          } catch (e) {}
        }

        res.json({
          endpoint: userinfoUrl,
          httpStatus: proxyRes.statusCode,
          contentType: contentType,
          rawBodyLength: data.length,
          rawBodyPreview: data.substring(0, 500),
          isJson: !!parsed,
          isJwt: !!jwtDecoded,
          parseError: parseError,
          parsedJson: parsed,
          jwtDecoded: jwtDecoded
        });
      });
    });

    proxyReq.on('error', (e) => {
      res.status(500).json({ error: 'Errore chiamata userinfo', details: e.message });
    });
    proxyReq.end();
  }
});

// API: user info JSON
app.get('/api/user', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Non autenticato', login_url: `${BASE_PATH}/login` });
  res.json({
    user: req.session.user,
    login_time: req.session.loginTime,
    client_id: CLIENT_ID,
    realm: REALM
  });
});

// Logout
app.get('/logout', (req, res) => {
  const idToken = req.session.tokenSet?.id_token;
  req.session.destroy(() => {
    if (idToken) {
      const logoutUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout?id_token_hint=${idToken}&post_logout_redirect_uri=${encodeURIComponent(APP_URL)}`;
      res.redirect(logoutUrl);
    } else {
      res.redirect(`${BASE_PATH}/`);
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), oidc_ready: !!oidcClient });
});

// Start server
initOIDC().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  SPID Test Login - ASP Messina');
    console.log('========================================');
    console.log(`  Server:     http://localhost:${PORT}`);
    console.log(`  App URL:    ${APP_URL}`);
    console.log(`  BASE_PATH:  ${BASE_PATH || '(root)'}`);
    console.log(`  Keycloak:   ${KEYCLOAK_URL}/realms/${REALM}`);
    console.log(`  Client:     ${CLIENT_ID}`);
    console.log('========================================');
    console.log('');
  });
}).catch(err => {
  console.error('Impossibile avviare:', err.message);
  process.exit(1);
});
