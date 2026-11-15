# AURA AI — v1.0 starter

Prima base multipiattaforma (PWA-ready) per il progetto AURA AI.

## Cosa contiene
- Dashboard benessere e check-in soggettivo 0–10.
- Conversazione dimostrativa con risposte locali di esempio.
- Sintesi vocale del browser e riconoscimento vocale quando supportato.
- Missioni di benessere facoltative.
- Grafico dei check-in salvati localmente.
- Backend adapter opzionale per collegare un provider AI senza esporre la chiave nel browser.

## Requisiti
Node.js 20 o successivo e npm.

## Avvio
```bash
npm install
npm run dev
```
Aprire l'indirizzo locale mostrato da Vite.

## Backend AI (opzionale)
Il frontend tenta `POST /api/chat`. Per sviluppo, avviare il server in un secondo terminale:
```bash
npm run server
```
Il server ascolta sulla porta 8787. Configurare `AURA_AI_ENDPOINT`, `AURA_AI_API_KEY` e `ALLOWED_ORIGIN` nell'ambiente server. L'endpoint configurato deve accettare `{ "message": "...", "system": "..." }` e restituire `{ "reply": "..." }`.
Per collegare frontend e backend in locale, configurare un proxy Vite `/api` verso `http://localhost:8787` (da aggiungere in vite.config.ts) oppure servire il frontend tramite un reverse proxy HTTPS.

## Importante
Questa è una **demo tecnica**, non un prodotto clinico e non un servizio di emergenza. Le risposte conversazionali locali sono esempi deterministici, non generate da un modello AI. Non usare dati reali sensibili in questa versione.
La modalità vocale dipende dal browser e dai permessi del dispositivo. Non è previsto ascolto in background quando l'app è chiusa.
Prima di un rilascio pubblico servono almeno: backend AI scelto e verificato, autenticazione, cifratura, consenso e gestione/cancellazione dati, privacy policy, valutazione GDPR, test accessibilità e protocollo clinico/sicurezza revisionato da professionisti.
