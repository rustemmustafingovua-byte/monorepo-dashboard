# Unified Monetization Dashboard

Сводный дашборд монетизации проектов: Lumen Chain, Perps Funding Pulse, Agent X402, Wallet Hygiene.

## Запуск

```bash
cd /tmp/monorepo-dashboard
node server.js
# → http://127.0.0.1:18900
```

## Проекты

### Lumen Chain
Запустите узел с push-статистикой:
```bash
cd /tmp/lumen-chain
DASHBOARD_WEBHOOK_URL=http://127.0.0.1:18900 npm run node -- serve --port=8899
```
Или сделайте запрос к `/api/state` — дашборд опросит `http://127.0.0.1:8899/api/state`.

### Perps Funding Pulse
```bash
cd /tmp/perps-funding-pulse
DASHBOARD_WEBHOOK_URL=http://127.0.0.1:18900 node src/server.js
```
Статистика (запросы, выручка) отправляется при каждом успешном вызове `/funding`.
Без переменной окружения работает без изменений.

### Agent X402
```bash
cd /tmp/agent-x402
DASHBOARD_WEBHOOK_URL=http://127.0.0.1:18900 node bin/stats-server.js
```
Сервер exposes `/stats` и опционально пушит в дашборд.

### Wallet Hygiene
```bash
cd /tmp/wallet-hygiene
DASHBOARD_WEBHOOK_URL=http://127.0.0.1:18900 node bin/wallet-hygiene.js keys
DASHBOARD_WEBHOOK_URL=http://127.0.0.1:18900 node bin/wallet-hygiene.js forgotten
```
Без переменной окружения работает без изменений.

## API

- `GET /` — дашборд
- `GET /api/aggregated` — JSON со статистикой
- `GET /health` — проверка
- `POST /webhook/:project` — приём push-статистики

## Зависимости

Нет. Только Node.js stdlib.
