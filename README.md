# poketype-server

Servidor multiplayer do PokéType Speed Challenge (Express + WebSocket).

## Rodando local

```bash
npm install
npm start
```

Sobe em `http://localhost:3000`, WebSocket em `ws://localhost:3000/ws`.

## Deploy na Render

- **Type:** Web Service
- **Root Directory:** `.` (este repo já é só o servidor)
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`

Não precisa de nenhuma variável de ambiente (`PORT` é injetada pela Render).

## Endpoints

- `GET /health` → `{ "ok": true }`
- `GET /` → `{ "ok": true, "service": "poketype-server", "ws": "/ws" }`
- `WS /ws` → protocolo do jogo (create_room, join_room, start_game, select_type, submit_guess, next_round...)
