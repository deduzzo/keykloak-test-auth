# Apps Development Guide

Guida per sviluppare applicazioni containerizzate che possono essere gestite tramite il sistema di apps management di ASP-WS.

## Indice

1. [Introduzione](#introduzione)
2. [Requisiti App](#requisiti-app)
3. [Implementazione BASE_PATH](#implementazione-base_path)
4. [Struttura Progetto](#struttura-progetto)
5. [Esempio Completo](#esempio-completo)
6. [WebSocket Support](#websocket-support)
7. [Testing Locale](#testing-locale)
8. [Deploy](#deploy)

## Introduzione

Le app vengono eseguite in container Docker e servite attraverso un reverse proxy al path `/apps/:appId/`. Per funzionare correttamente, le app devono:

1. Leggere la variabile d'ambiente `BASE_PATH`
2. Usare il BASE_PATH per tutti i riferimenti a risorse (API, assets, routing)
3. Esporre il servizio sulla porta 3000 del container

## Requisiti App

### 1. Porta del Container

L'app deve essere in ascolto sulla **porta 3000** all'interno del container:

```javascript
// Node.js/Express example
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

### 2. Variabile d'Ambiente BASE_PATH

Il sistema inietta automaticamente la variabile `BASE_PATH` nel container:

```bash
BASE_PATH=/apps/your-app-id
```

Questa variabile è disponibile **server-side** (nel processo Node.js) ma NON nel browser.

### 3. Package.json

Il `package.json` deve contenere gli script necessari:

```json
{
  "name": "your-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js",
    "build": "npm install"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

## Implementazione BASE_PATH

### Approccio Consigliato: Leggere BASE_PATH dall'URL

Il modo più semplice e diretto è leggere il BASE_PATH direttamente dall'URL del browser:

```javascript
// L'app è servita su: https://ws1.asp.messina.it/apps/presidi-distretti-asp-messina/
// Estrai APP_ID e costruisci BASE_PATH dall'URL
const pathMatch = window.location.pathname.match(/^\/apps\/([^\/]+)/);
const APP_ID = pathMatch ? pathMatch[1] : '';
const BASE_PATH = APP_ID ? `/apps/${APP_ID}` : '';

console.log('APP_ID:', APP_ID);        // presidi-distretti-asp-messina
console.log('BASE_PATH:', BASE_PATH);  // /apps/presidi-distretti-asp-messina
```

#### Server-side (Opzionale)

Se vuoi che il server conosca il proprio BASE_PATH (utile per logging o altre operazioni), puoi leggerlo dalla variabile d'ambiente:

```javascript
// server.js
const express = require('express');
const app = express();

const BASE_PATH = process.env.BASE_PATH || '';
console.log('Server BASE_PATH:', BASE_PATH);

// Altri endpoint dell'app
app.get('/api/data', (req, res) => {
  res.json({ message: 'Hello from app!' });
});

// Servire file statici
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

#### Step 2: Leggere la configurazione nel client

Nel client (HTML/JavaScript), l'app deve chiamare l'endpoint di configurazione del sistema principale (NON del proprio server interno). L'endpoint è servito dal reverse proxy a livello root:

**Importante**: L'endpoint `/api/v1/apps/:appId/config` NON viene proxato attraverso l'app, ma è servito direttamente dal server principale.

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
</head>
<body>
  <h1>My App</h1>
  <div id="content">Loading...</div>

  <script>
    // Variabile globale per il BASE_PATH
    let BASE_PATH = '';
    let APP_ID = '';

    // Inizializza l'app
    async function init() {
      try {
        // Determina l'APP_ID dall'URL corrente
        // Se l'app è su: https://ws1.asp.messina.it/apps/presidi-distretti-asp-messina/
        const pathMatch = window.location.pathname.match(/^\/apps\/([^\/]+)/);
        if (pathMatch) {
          APP_ID = pathMatch[1];
          BASE_PATH = `/apps/${APP_ID}`;
        }

        console.log('APP_ID:', APP_ID);
        console.log('BASE_PATH:', BASE_PATH);

        // Ora puoi usare BASE_PATH per le chiamate API interne dell'app
        loadData();
      } catch (err) {
        console.error('Error during initialization:', err);
      }
    }

    // Esempio di chiamata API usando BASE_PATH
    async function loadData() {
      const response = await fetch(`${BASE_PATH}/api/data`);
      const data = await response.json();
      document.getElementById('content').textContent = data.message;
    }

    // Avvia l'app
    init();
  </script>
</body>
</html>
```

### Approccio Alternativo: Endpoint di Sistema (Non Consigliato)

~~Il sistema ASP-WS espone un endpoint pubblico per ottenere la configurazione dell'app:~~

```
GET /api/v1/apps/:appId/config
```

**ATTENZIONE**: Questo endpoint NON è accessibile dall'interno dell'app perché non viene proxato. È un endpoint del server principale, non dell'app containerizzata.

**Non usare questo approccio** - usa invece la lettura dall'URL come mostrato sopra.

## Struttura Progetto

### Esempio Node.js/Express

```
my-app/
├── package.json
├── server.js
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

### Esempio con Framework (React, Vue, etc.)

```
my-app/
├── package.json
├── server.js          # Server Express per servire la build
├── vite.config.js     # o webpack.config.js
└── src/
    ├── main.js
    ├── App.vue
    └── api/
        └── config.js  # Utility per gestire BASE_PATH
```

## Esempio Completo

### Node.js + Express + Vanilla JS

**package.json:**
```json
{
  "name": "example-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

**server.js:**
```javascript
const express = require('express');
const path = require('path');
const app = express();

// Log BASE_PATH all'avvio (opzionale, utile per debug)
const BASE_PATH = process.env.BASE_PATH || '';
console.log(`BASE_PATH: ${BASE_PATH || '(not set)'}`);

// API di esempio
app.get('/api/users', (req, res) => {
  res.json([
    { id: 1, name: 'John Doe' },
    { id: 2, name: 'Jane Smith' }
  ]);
});

// Servire file statici
app.use(express.static('public'));

// Fallback per SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

**public/index.html:**
```html
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Example App</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
    }
    .user {
      padding: 10px;
      border: 1px solid #ddd;
      margin: 10px 0;
    }
  </style>
</head>
<body>
  <h1>Example App</h1>
  <p>BASE_PATH: <code id="basePath">Loading...</code></p>
  <h2>Users</h2>
  <div id="users">Loading...</div>

  <script>
    let BASE_PATH = '';
    let APP_ID = '';

    async function init() {
      try {
        // Determina BASE_PATH dall'URL
        // Es: https://ws1.asp.messina.it/apps/presidi-distretti-asp-messina/
        const pathMatch = window.location.pathname.match(/^\/apps\/([^\/]+)/);
        if (pathMatch) {
          APP_ID = pathMatch[1];
          BASE_PATH = `/apps/${APP_ID}`;
        }

        console.log('APP_ID:', APP_ID);
        console.log('BASE_PATH:', BASE_PATH);

        document.getElementById('basePath').textContent = BASE_PATH || '(root)';

        // Carica dati
        await loadUsers();
      } catch (err) {
        console.error('Error:', err);
        document.getElementById('users').innerHTML =
          '<p style="color: red;">Error loading data</p>';
      }
    }

    async function loadUsers() {
      const response = await fetch(`${BASE_PATH}/api/users`);
      const users = await response.json();

      const html = users.map(u =>
        `<div class="user">
          <strong>${u.name}</strong> (ID: ${u.id})
        </div>`
      ).join('');

      document.getElementById('users').innerHTML = html;
    }

    // Avvia app
    init();
  </script>
</body>
</html>
```

## WebSocket Support

Il reverse proxy supporta connessioni WebSocket in aggiunta alle normali richieste HTTP. Questo permette alle app di usare librerie come Socket.io, ws, o qualsiasi altro protocollo basato su WebSocket.

### Come Funziona

Le connessioni WebSocket vengono automaticamente proxate attraverso `/apps/:appId/`. Quando il browser apre una connessione WebSocket verso `/apps/my-app/socket.io/...`, il proxy:

1. Intercetta la richiesta di upgrade HTTP -> WebSocket
2. La inoltra al container Docker sulla porta corretta
3. Mantiene la connessione bidirezionale attiva

Non serve configurazione aggiuntiva lato sistema: basta che la tua app ascolti connessioni WebSocket sulla porta 3000.

### Esempio con Socket.io

**Server (server.js):**

```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);

const BASE_PATH = process.env.BASE_PATH || '';

// Socket.io con path configurato per il reverse proxy
const io = new Server(httpServer, {
  path: `${BASE_PATH}/socket.io/`,
  cors: { origin: '*' }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('message', (data) => {
    console.log('Message received:', data);
    socket.emit('response', { echo: data, timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Servire file statici
app.use(express.static('public'));

// API REST di esempio
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', connections: io.engine.clientsCount });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}, BASE_PATH: ${BASE_PATH}`);
});
```

**Client (public/index.html):**

```html
<!DOCTYPE html>
<html>
<head>
  <title>WebSocket App</title>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
</head>
<body>
  <h1>WebSocket Demo</h1>
  <div id="status">Connecting...</div>
  <input type="text" id="message" placeholder="Type a message">
  <button onclick="sendMessage()">Send</button>
  <div id="messages"></div>

  <script>
    // Determina BASE_PATH dall'URL
    const pathMatch = window.location.pathname.match(/^\/apps\/([^\/]+)/);
    const APP_ID = pathMatch ? pathMatch[1] : '';
    const BASE_PATH = APP_ID ? `/apps/${APP_ID}` : '';

    // Connessione Socket.io con path corretto
    const socket = io({
      path: `${BASE_PATH}/socket.io/`
    });

    socket.on('connect', () => {
      document.getElementById('status').textContent = 'Connected!';
    });

    socket.on('disconnect', () => {
      document.getElementById('status').textContent = 'Disconnected';
    });

    socket.on('response', (data) => {
      const div = document.createElement('div');
      div.textContent = `Server: ${JSON.stringify(data)}`;
      document.getElementById('messages').appendChild(div);
    });

    function sendMessage() {
      const input = document.getElementById('message');
      socket.emit('message', input.value);
      input.value = '';
    }
  </script>
</body>
</html>
```

**package.json:**

```json
{
  "name": "websocket-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.0",
    "socket.io": "^4.7.0"
  }
}
```

### Esempio con ws (WebSocket nativo)

Se preferisci WebSocket nativo senza Socket.io:

**Server:**

```javascript
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    ws.send(`Echo: ${data}`);
  });
});

app.use(express.static('public'));

server.listen(process.env.PORT || 3000);
```

**Client:**

```javascript
const pathMatch = window.location.pathname.match(/^\/apps\/([^\/]+)/);
const BASE_PATH = pathMatch ? `/apps/${pathMatch[1]}` : '';
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}${BASE_PATH}/`);

ws.onmessage = (event) => console.log('Received:', event.data);
ws.onopen = () => ws.send('Hello!');
```

### Note Importanti

- **Il path Socket.io deve includere BASE_PATH**: sia lato server (`new Server(httpServer, { path: \`${BASE_PATH}/socket.io/\` })`) che lato client (`io({ path: \`${BASE_PATH}/socket.io/\` })`)
- **WebSocket nativo non richiede path speciale**: il proxy riscrive automaticamente il percorso
- **Una sola porta**: sia HTTP che WebSocket devono usare la stessa porta 3000 nel container
- **Reconnection**: Socket.io gestisce automaticamente la riconnessione; con ws nativo dovrai implementarla manualmente

## Testing Locale

### Testare senza Docker

```bash
# Senza BASE_PATH (root)
npm start

# Con BASE_PATH simulato
BASE_PATH=/apps/test npm start
```

Apri il browser su `http://localhost:3000`

### Testare con Docker localmente

```bash
# Build immagine
docker build -t my-app .

# Run con BASE_PATH
docker run -p 3000:3000 -e BASE_PATH=/apps/test my-app
```

Apri il browser su `http://localhost:3000`

### Dockerfile di esempio

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
```

## Deploy

### Upload tramite ZIP

1. Comprimi il progetto in un file `.zip`
2. Accedi all'interfaccia di gestione apps
3. Carica il file ZIP
4. Configura le variabili d'ambiente (opzionali)
5. Avvia l'app

### Upload tramite GitHub

1. Pusha il codice su GitHub
2. Nell'interfaccia apps, inserisci l'URL del repository
3. Seleziona il branch (default: main)
4. L'app verrà clonata e avviata automaticamente

## Best Practices

1. **Sempre testare con BASE_PATH**: Testa l'app sia con che senza BASE_PATH
2. **Logging**: Logga il BASE_PATH all'avvio per debug
3. **Error Handling**: Gestisci gli errori di rete nella fetch del config
4. **Caching**: Considera di cachare il BASE_PATH dopo la prima fetch
5. **Assets relativi**: Usa path relativi per CSS/JS o usa BASE_PATH
6. **API calls**: Tutte le chiamate API devono usare `${BASE_PATH}/api/...`

## Troubleshooting

### L'app non si avvia

- Verifica che `package.json` contenga lo script `"start"`
- Controlla i log del container
- Assicurati che l'app sia in ascolto sulla porta 3000

### Le API non funzionano

- Verifica che le chiamate usino `${BASE_PATH}/api/...`
- Controlla la console del browser per errori
- Verifica il BASE_PATH con `console.log(BASE_PATH)`

### Assets non caricati (CSS, JS, immagini)

- Usa path relativi: `./style.css` invece di `/style.css`
- Oppure usa BASE_PATH: `${BASE_PATH}/style.css`
- Verifica che i file siano in `public/` o nella cartella static

## Supporto

Per problemi o domande, consulta la documentazione o apri una issue nel repository del progetto.
