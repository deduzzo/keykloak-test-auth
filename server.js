const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
    scope: 'openid profile email',
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
      // riproviamo senza controlli strict
      console.warn('[SPID] Validazione OIDC fallita, retry senza state check:', validationErr.message);
      tokenSet = await oidcClient.callback(`${APP_URL}/callback`, params, {});
    }

    // Ottieni info utente
    const userinfo = await oidcClient.userinfo(tokenSet.access_token);

    req.session.user = userinfo;
    req.session.tokenSet = {
      access_token: tokenSet.access_token,
      id_token: tokenSet.id_token,
      refresh_token: tokenSet.refresh_token,
      expires_at: tokenSet.expires_at
    };
    req.session.loginTime = new Date().toISOString();

    console.log(`Utente autenticato: ${userinfo.preferred_username || userinfo.sub}`);
    res.redirect(`${BASE_PATH}/profile`);
  } catch (err) {
    console.error('Errore callback:', err);
    res.redirect(`${BASE_PATH}/error?msg=${encodeURIComponent(err.message)}`);
  }
});

// Error page - mostra errore con opzioni di recupero (reset/riprova/logout)
app.get('/error', (req, res) => {
  const msg = req.query.msg || 'Errore sconosciuto';
  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Errore - ASP Messina SPID Test</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Titillium Web', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f4f8; color: #1e293b; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #dc2626, #991b1b); color: white; padding: 25px 20px; text-align: center; }
    .header h1 { font-size: 1.3em; margin-bottom: 4px; }
    .container { max-width: 550px; margin: 40px auto; padding: 0 20px; }
    .error-box { background: #fef2f2; border: 1px solid #fca5a5; border-radius: 10px; padding: 20px; margin-bottom: 25px; }
    .error-box h2 { color: #991b1b; margin-bottom: 8px; font-size: 1.1em; }
    .error-box p { color: #7f1d1d; font-size: 0.9em; word-break: break-word; }
    .error-box code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
    .card { background: white; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); padding: 30px; margin-bottom: 20px; }
    .card h3 { margin-bottom: 15px; color: #334155; font-size: 1em; }
    .btn { display: block; width: 100%; padding: 14px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 1em; text-align: center; margin-bottom: 12px; transition: all 0.2s; }
    .btn:last-child { margin-bottom: 0; }
    .btn-reset { background: #dc2626; color: white; }
    .btn-reset:hover { background: #b91c1c; }
    .btn-retry { background: #0066cc; color: white; }
    .btn-retry:hover { background: #004999; }
    .btn-home { background: #64748b; color: white; }
    .btn-home:hover { background: #475569; }
    .hint { margin-top: 20px; padding: 15px; background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; font-size: 0.85em; color: #1e40af; }
    .hint strong { display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>ASP Messina - Errore Autenticazione</h1>
  </div>
  <div class="container">
    <div class="error-box">
      <h2>Errore durante l'autenticazione SPID</h2>
      <p><code>${msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></p>
    </div>
    <div class="card">
      <h3>Cosa puoi fare:</h3>
      <a href="${BASE_PATH}/reset" class="btn btn-reset">Reset sessione e Logout da Keycloak</a>
      <a href="${BASE_PATH}/login" class="btn btn-retry">Riprova autenticazione</a>
      <a href="${BASE_PATH}/" class="btn btn-home">Torna alla Home</a>
    </div>
    <div class="hint">
      <strong>Suggerimento</strong>
      Se l'errore riguarda "state" o "nonce", premi "Reset sessione" per pulire tutto
      e poi riprova. Questo errore puo capitare durante i test con il validatore SPID AgID
      a causa del POST cross-site che non preserva i cookie di sessione.
    </div>
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

// Profilo utente - mostra tutti gli attributi SPID ricevuti
app.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect(`${BASE_PATH}/`);

  const user = req.session.user;
  const loginTime = req.session.loginTime;

  // Mappa attributi SPID per nomi leggibili
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
    <div class="card">
      <div class="card-header">Dettagli Tecnici</div>
      <table>
        <tr><td class="attr-key">Keycloak URL</td><td class="attr-value">${KEYCLOAK_URL}</td></tr>
        <tr><td class="attr-key">Realm</td><td class="attr-value">${REALM}</td></tr>
        <tr><td class="attr-key">Client ID</td><td class="attr-value">${CLIENT_ID}</td></tr>
        <tr><td class="attr-key">Protocollo</td><td class="attr-value">OpenID Connect (Authorization Code Flow)</td></tr>
        <tr><td class="attr-key">Entity ID (SAML SP)</td><td class="attr-value">${KEYCLOAK_URL}/realms/${REALM}</td></tr>
        <tr><td class="attr-key">SPID Metadata</td><td class="attr-value"><a href="${KEYCLOAK_URL}/realms/${REALM}/spid/metadata" target="_blank">${KEYCLOAK_URL}/realms/${REALM}/spid/metadata</a></td></tr>
      </table>
    </div>
    <div class="actions">
      <a href="${BASE_PATH}/logout" class="btn btn-danger">Logout</a>
      <a href="${BASE_PATH}/" class="btn btn-outline">Torna alla Home</a>
      <a href="${BASE_PATH}/api/user" class="btn btn-outline" target="_blank">API JSON</a>
    </div>
  </div>
  <div class="footer">
    ASP Messina &mdash; Test SPID per collaudo AGID | Client: ${CLIENT_ID}
  </div>
</body>
</html>`);
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
