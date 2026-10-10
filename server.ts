import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import rawData from './pokemonData.json';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = Number(process.env.PORT) || 3000;

// Liberado p/ o client no GitHub Pages (origin diferente).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'poketype-server', ws: '/ws' });
});

// Type definition and map from pokemonData.json
const ALL_TYPES = [
  'normal', 'fire', 'water', 'grass', 'electric', 'ice',
  'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug',
  'rock', 'ghost', 'dragon', 'steel', 'dark', 'fairy'
] as const;

type PokemonTypeId = typeof ALL_TYPES[number];

interface CompactPokemon {
  id: number;
  name: string;
  types: PokemonTypeId[];
}

const pokemonMap = new Map<number, CompactPokemon>();
(rawData.allPokemon as Array<{ id: number; name: string; types: string[] }>).forEach((p) => {
  pokemonMap.set(p.id, {
    id: p.id,
    name: p.name,
    types: p.types as PokemonTypeId[],
  });
});

type Difficulty = 'easy' | 'medium' | 'hard';

// Multiplayer Room Model
interface Player {
  id: string;
  name: string;
  color: string;
  score: number;
  isHost: boolean;
  ws: WebSocket;
  records: Array<{
    round: number;
    pokemon: CompactPokemon;
    typeId: PokemonTypeId | PokemonTypeId[];
    reactionTimeMs: number;
  }>;
}

interface RoundGuess {
  playerId: string;
  playerName: string;
  pokemon: CompactPokemon;
  isValid: boolean;
  reactionTimeMs: number;
  timestamp: number;
}

interface Room {
  code: string;
  players: Player[];
  status: 'lobby' | 'selecting_type' | 'shuffling' | 'playing' | 'round_won' | 'game_won';
  activePlayerIndex: number;
  selectorPlayerId: string | null;
  selectorPlayerIds: string[];
  numTypeSelectors: number;
  currentTypeSelections: Record<string, PokemonTypeId | PokemonTypeId[]>;
  playerSelectsType: boolean;
  currentType: PokemonTypeId | PokemonTypeId[] | null;
  roundStartTime: number;
  roundNumber: number;
  difficulty: Difficulty;
  usedPokemonIds: number[];
  winnerId: string | null;
  lastScoredPlayerId: string | null;
  lastRoundWinnerId: string | null;
  currentGuesses: Record<string, RoundGuess>;
  lastRoundGuesses: Record<string, RoundGuess> | null;
}

const rooms = new Map<string, Room>();

const PLAYER_COLORS = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ec4899', '#eab308'];

function sanitizeRoom(room: Room) {
  return {
    code: room.code,
    status: room.status,
    activePlayerIndex: room.activePlayerIndex,
    selectorPlayerId: room.selectorPlayerId,
    selectorPlayerIds: room.selectorPlayerIds,
    numTypeSelectors: room.numTypeSelectors,
    submittedSelectorIds: Object.keys(room.currentTypeSelections),
    playerSelectsType: room.playerSelectsType,
    currentType: room.currentType,
    roundStartTime: room.roundStartTime,
    roundNumber: room.roundNumber,
    difficulty: room.difficulty,
    usedPokemonIds: room.usedPokemonIds,
    winnerId: room.winnerId,
    lastScoredPlayerId: room.lastScoredPlayerId,
    lastRoundWinnerId: room.lastRoundWinnerId,
    currentGuesses: room.currentGuesses,
    lastRoundGuesses: room.lastRoundGuesses,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      isHost: p.isHost,
      records: p.records,
    })),
  };
}

function broadcastToRoom(room: Room, message: object) {
  const payload = JSON.stringify(message);
  for (const player of room.players) {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(payload);
    }
  }
}

function rollNewType(): PokemonTypeId {
  const index = Math.floor(Math.random() * ALL_TYPES.length);
  return ALL_TYPES[index];
}

function areTypesCompatible(t1: PokemonTypeId, t2: PokemonTypeId, difficulty: Difficulty): boolean {
  if (t1 === t2) return true;
  const maxDex = difficulty === 'hard' ? 151 : difficulty === 'medium' ? 493 : 1025;
  for (const p of pokemonMap.values()) {
    if (p.id <= maxDex && p.types.includes(t1) && p.types.includes(t2)) {
      return true;
    }
  }
  return false;
}

function resolveTypeVotes(
  votes: PokemonTypeId[],
  difficulty: Difficulty
): PokemonTypeId | PokemonTypeId[] {
  if (votes.length === 0) return rollNewType();
  if (votes.length === 1) return votes[0];

  // Frequency map
  const countMap = new Map<PokemonTypeId, number>();
  for (const t of votes) {
    countMap.set(t, (countMap.get(t) || 0) + 1);
  }

  // If all voted for identical type
  if (countMap.size === 1) {
    return votes[0];
  }

  // 2 votes case
  if (votes.length === 2 && countMap.size === 2) {
    const [t1, t2] = votes;
    if (areTypesCompatible(t1, t2, difficulty)) {
      return [t1, t2];
    } else {
      // Incompatible: silently pick one of the two
      return Math.random() < 0.5 ? t1 : t2;
    }
  }

  // 3+ votes case: rank by vote count descending
  const sortedCounts = Array.from(countMap.entries()).sort((a, b) => b[1] - a[1]);

  const maxVotes = sortedCounts[0][1];
  const tiedForFirst = sortedCounts.filter((c) => c[1] === maxVotes).map((c) => c[0]);

  let firstPlace: PokemonTypeId;
  let secondPlace: PokemonTypeId | null = null;

  if (tiedForFirst.length >= 2) {
    // 2 or more tied for first place: random eliminatória among tied candidates
    const shuffledFirst = [...tiedForFirst].sort(() => Math.random() - 0.5);
    firstPlace = shuffledFirst[0];
    secondPlace = shuffledFirst[1];
  } else {
    // Exactly 1 in 1st place
    firstPlace = tiedForFirst[0];

    // Find 2nd place candidates
    const remaining = sortedCounts.filter((c) => c[0] !== firstPlace);
    if (remaining.length > 0) {
      const secondMaxVotes = remaining[0][1];
      const tiedForSecond = remaining.filter((c) => c[1] === secondMaxVotes).map((c) => c[0]);
      // Random eliminatória among candidates tied for 2nd place
      const shuffledSecond = [...tiedForSecond].sort(() => Math.random() - 0.5);
      secondPlace = shuffledSecond[0];
    }
  }

  if (!secondPlace || firstPlace === secondPlace) {
    return firstPlace;
  }

  // Check compatibility of top 2 places
  if (areTypesCompatible(firstPlace, secondPlace, difficulty)) {
    return [firstPlace, secondPlace];
  } else {
    // Incompatible: silently select one of the two (favoring the one with more votes)
    const count1 = countMap.get(firstPlace) || 0;
    const count2 = countMap.get(secondPlace) || 0;
    if (count1 > count2) {
      return firstPlace;
    } else {
      return Math.random() < 0.5 ? firstPlace : secondPlace;
    }
  }
}

function finalizeTypeSelectionAndStart(room: Room) {
  const rawVotes = room.selectorPlayerIds
    .map((id) => room.currentTypeSelections[id])
    .filter(Boolean);

  let resolvedType: PokemonTypeId | PokemonTypeId[];
  if (rawVotes.length === 1 && Array.isArray(rawVotes[0])) {
    resolvedType = rawVotes[0];
  } else {
    const flatVotes: PokemonTypeId[] = [];
    for (const v of rawVotes) {
      if (Array.isArray(v)) {
        flatVotes.push(...v);
      } else if (v) {
        flatVotes.push(v);
      }
    }
    resolvedType = resolveTypeVotes(flatVotes, room.difficulty);
  }

  room.status = 'playing';
  room.currentType = resolvedType;
  room.roundStartTime = Date.now();
  room.roundNumber++;
  room.currentGuesses = {};

  broadcastToRoom(room, {
    type: 'round_started',
    room: sanitizeRoom(room),
  });
}

function startRoundForRoom(room: Room) {
  room.status = 'playing';
  room.currentType = rollNewType();
  room.roundStartTime = Date.now();
  room.roundNumber++;
  room.currentGuesses = {};
  broadcastToRoom(room, {
    type: 'round_started',
    room: sanitizeRoom(room),
  });
}

function startNextRoundOrTypeSelection(room: Room) {
  room.currentGuesses = {};
  room.currentTypeSelections = {};
  if (room.playerSelectsType) {
    room.status = 'selecting_type';
    const numToPick = Math.max(1, Math.min(room.numTypeSelectors || 2, room.players.length));
    const startIndex = room.roundNumber % room.players.length;
    const selectors: string[] = [];
    for (let i = 0; i < numToPick; i++) {
      const idx = (startIndex + i) % room.players.length;
      selectors.push(room.players[idx].id);
    }
    room.selectorPlayerIds = selectors;
    room.selectorPlayerId = selectors[0];
    room.activePlayerIndex = startIndex;
    broadcastToRoom(room, {
      type: 'selecting_type',
      room: sanitizeRoom(room),
    });
  } else {
    startRoundForRoom(room);
  }
}

// WebSocket Connection Handler
wss.on('connection', (ws: WebSocket) => {
  let currentPlayerId: string | null = null;
  let currentRoomCode: string | null = null;

  ws.on('message', (data: string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'create_room') {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        currentPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
        currentRoomCode = roomCode;

        const newPlayer: Player = {
          id: currentPlayerId,
          name: (msg.name || 'Jogador 1').trim().substring(0, 15),
          color: PLAYER_COLORS[0],
          score: 0,
          isHost: true,
          ws,
          records: [],
        };

        const numTypeSelectors = Math.min(6, Math.max(1, Number(msg.numTypeSelectors) || 2));

        const newRoom: Room = {
          code: roomCode,
          players: [newPlayer],
          status: 'lobby',
          activePlayerIndex: 0,
          selectorPlayerId: currentPlayerId,
          selectorPlayerIds: [currentPlayerId],
          numTypeSelectors,
          currentTypeSelections: {},
          playerSelectsType: msg.playerSelectsType !== false,
          currentType: null,
          roundStartTime: 0,
          roundNumber: 0,
          difficulty: msg.difficulty || 'easy',
          usedPokemonIds: [],
          winnerId: null,
          lastScoredPlayerId: null,
          lastRoundWinnerId: null,
          currentGuesses: {},
          lastRoundGuesses: null,
        };

        rooms.set(roomCode, newRoom);

        ws.send(
          JSON.stringify({
            type: 'room_joined',
            playerId: currentPlayerId,
            room: sanitizeRoom(newRoom),
          })
        );
      } else if (msg.type === 'join_room') {
        const code = (msg.code || '').trim().toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada!' }));
          return;
        }

        if (room.players.length >= 6) {
          ws.send(JSON.stringify({ type: 'error', message: 'A sala está cheia (máx 6 jogadores)!' }));
          return;
        }

        if (room.status !== 'lobby') {
          ws.send(JSON.stringify({ type: 'error', message: 'A partida já começou nesta sala!' }));
          return;
        }

        currentPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
        currentRoomCode = code;

        const playerColor = PLAYER_COLORS[room.players.length % PLAYER_COLORS.length];
        const newPlayer: Player = {
          id: currentPlayerId,
          name: (msg.name || `Jogador ${room.players.length + 1}`).trim().substring(0, 15),
          color: playerColor,
          score: 0,
          isHost: false,
          ws,
          records: [],
        };

        room.players.push(newPlayer);

        ws.send(
          JSON.stringify({
            type: 'room_joined',
            playerId: currentPlayerId,
            room: sanitizeRoom(room),
          })
        );

        broadcastToRoom(room, {
          type: 'player_joined',
          room: sanitizeRoom(room),
        });
      } else if (msg.type === 'set_difficulty') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;
        const player = room.players.find((p) => p.id === currentPlayerId);
        if (!player || !player.isHost) return;

        if (['easy', 'medium', 'hard'].includes(msg.difficulty)) {
          room.difficulty = msg.difficulty;
          broadcastToRoom(room, {
            type: 'room_updated',
            room: sanitizeRoom(room),
          });
        }
      } else if (msg.type === 'set_room_settings') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || room.status !== 'lobby') return;
        const player = room.players.find((p) => p.id === currentPlayerId);
        if (!player || !player.isHost) return;

        if (msg.playerSelectsType !== undefined) {
          room.playerSelectsType = Boolean(msg.playerSelectsType);
        }
        if (msg.numTypeSelectors !== undefined) {
          const n = Number(msg.numTypeSelectors);
          if (n >= 1 && n <= 6) {
            room.numTypeSelectors = Math.floor(n);
          }
        }
        if (msg.difficulty && ['easy', 'medium', 'hard'].includes(msg.difficulty)) {
          room.difficulty = msg.difficulty;
        }
        broadcastToRoom(room, {
          type: 'room_updated',
          room: sanitizeRoom(room),
        });
      } else if (msg.type === 'start_game') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        const player = room.players.find((p) => p.id === currentPlayerId);
        if (!player || !player.isHost) {
          ws.send(JSON.stringify({ type: 'error', message: 'Apenas o anfitrião pode iniciar a partida.' }));
          return;
        }

        if (room.players.length < 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'Nenhum jogador na sala.' }));
          return;
        }

        room.usedPokemonIds = [];
        room.activePlayerIndex = 0;
        room.roundNumber = 0;
        room.winnerId = null;
        room.lastScoredPlayerId = null;
        room.lastRoundWinnerId = null;
        room.currentGuesses = {};
        room.currentTypeSelections = {};
        room.lastRoundGuesses = null;
        room.players.forEach((p) => {
          p.score = 0;
          p.records = [];
        });

        startNextRoundOrTypeSelection(room);
      } else if (msg.type === 'select_type') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || room.status !== 'selecting_type') return;

        if (!currentPlayerId || !room.selectorPlayerIds.includes(currentPlayerId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Não é sua vez de escolher o tipo.' }));
          return;
        }

        const rawTypes = Array.isArray(msg.types) ? msg.types : [msg.typeId];
        const validTypes = rawTypes.filter((t: string) => ALL_TYPES.includes(t as PokemonTypeId)) as PokemonTypeId[];
        if (validTypes.length === 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Selecione pelo menos 1 tipo válido.' }));
          return;
        }

        // If only 1 player is selecting this round, allow 1 or 2 types.
        // If 2+ players are selecting, each player chooses 1 type.
        const chosenType: PokemonTypeId | PokemonTypeId[] =
          room.selectorPlayerIds.length === 1 && validTypes.length >= 2
            ? [validTypes[0], validTypes[1]]
            : validTypes[0];

        room.currentTypeSelections[currentPlayerId] = chosenType;

        // Check if all designated selectors have submitted
        const allSubmitted = room.selectorPlayerIds.every(
          (id) => room.currentTypeSelections[id] !== undefined
        );

        if (allSubmitted) {
          finalizeTypeSelectionAndStart(room);
        } else {
          broadcastToRoom(room, {
            type: 'room_updated',
            room: sanitizeRoom(room),
          });
        }
      } else if (msg.type === 'submit_guess') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || room.status !== 'playing' || !room.currentType) return;

        if (!currentPlayerId) return;
        const pId = currentPlayerId;
        const player = room.players.find((p) => p.id === pId);
        if (!player) return;

        // Check if player already made their guess this round
        if (room.currentGuesses[pId]) {
          return;
        }

        const pokemonId = Number(msg.pokemonId);
        const pokemon = pokemonMap.get(pokemonId);
        if (!pokemon) {
          ws.send(JSON.stringify({ type: 'error', message: 'Pokémon inválido.' }));
          return;
        }

        // Check difficulty restriction
        let fitsDifficulty = true;
        if (room.difficulty === 'hard' && pokemon.id > 151) fitsDifficulty = false;
        if (room.difficulty === 'medium' && pokemon.id > 493) fitsDifficulty = false;

        // Check if already used in previous rounds of this match
        const alreadyUsed = room.usedPokemonIds.includes(pokemonId);

        // Validate target type (single or dual combination)
        const hasTargetType = Array.isArray(room.currentType)
          ? room.currentType.every((t) => pokemon.types.includes(t))
          : pokemon.types.includes(room.currentType);

        const isValid = hasTargetType && !alreadyUsed && fitsDifficulty;
        const reactionTimeMs = Date.now() - room.roundStartTime;

        // Register this player's guess
        room.currentGuesses[pId] = {
          playerId: pId,
          playerName: player.name,
          pokemon: {
            id: pokemon.id,
            name: pokemon.name,
            types: pokemon.types,
          },
          isValid,
          reactionTimeMs,
          timestamp: Date.now(),
        };

        // Notify room that this player guessed
        broadcastToRoom(room, {
          type: 'player_submitted_guess',
          playerId: pId,
          playerName: player.name,
          guessedCount: Object.keys(room.currentGuesses).length,
          totalPlayers: room.players.length,
          room: sanitizeRoom(room),
        });

        // "Os dois tem que jogar ao mesmo tempo: Os dois falam um Pokémon, e quando os dois terminarem de guessar, vê quem ganhou."
        const allFinished = room.players.every((p) => room.currentGuesses[p.id]);

        if (allFinished) {
          const guessesList = Object.values(room.currentGuesses);
          const validGuesses = guessesList.filter((g) => g.isValid);

          if (validGuesses.length > 0) {
            // Sort by reaction time: lowest reaction time wins!
            validGuesses.sort((a, b) => a.reactionTimeMs - b.reactionTimeMs);
            const winnerGuess = validGuesses[0];
            const winnerPlayer = room.players.find((p) => p.id === winnerGuess.playerId);

            if (winnerPlayer) {
              winnerPlayer.score++;
              room.lastScoredPlayerId = winnerPlayer.id;
              room.lastRoundWinnerId = winnerPlayer.id;

              winnerPlayer.records.push({
                round: winnerPlayer.score,
                pokemon: winnerGuess.pokemon,
                typeId: room.currentType,
                reactionTimeMs: winnerGuess.reactionTimeMs,
              });

              if (winnerPlayer.score >= 5) {
                room.status = 'game_won';
                room.winnerId = winnerPlayer.id;
              } else {
                room.status = 'round_won';
              }
            }
          } else {
            // Neither player was valid
            room.lastScoredPlayerId = null;
            room.lastRoundWinnerId = null;
            room.status = 'round_won';
          }

          // Register all valid pokemon guessed into usedPokemonIds
          validGuesses.forEach((g) => {
            if (!room.usedPokemonIds.includes(g.pokemon.id)) {
              room.usedPokemonIds.push(g.pokemon.id);
            }
          });

          room.lastRoundGuesses = { ...room.currentGuesses };

          broadcastToRoom(room, {
            type: 'round_won',
            scoredPlayerId: room.lastRoundWinnerId,
            winnerId: room.lastRoundWinnerId,
            lastRoundGuesses: room.lastRoundGuesses,
            room: sanitizeRoom(room),
          });
        }
      } else if (msg.type === 'round_timeout') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room || room.status !== 'playing') return;

        startNextRoundOrTypeSelection(room);
      } else if (msg.type === 'next_round') {
        if (!currentRoomCode) return;
        const room = rooms.get(currentRoomCode);
        if (!room) return;

        if (room.status === 'game_won') {
          // Restart game if requested
          room.status = 'lobby';
          room.players.forEach((p) => {
            p.score = 0;
            p.records = [];
          });
          room.usedPokemonIds = [];
          room.winnerId = null;
          room.lastScoredPlayerId = null;
          room.lastRoundWinnerId = null;
          room.currentGuesses = {};
          room.lastRoundGuesses = null;
          broadcastToRoom(room, {
            type: 'room_reset',
            room: sanitizeRoom(room),
          });
          return;
        }

        if (room.status === 'round_won') {
          startNextRoundOrTypeSelection(room);
        }
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoomCode && currentPlayerId) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.players = room.players.filter((p) => p.id !== currentPlayerId);
        if (room.players.length === 0) {
          rooms.delete(currentRoomCode);
        } else {
          // Reassign host if host left
          if (!room.players.some((p) => p.isHost)) {
            room.players[0].isHost = true;
          }
          if (room.activePlayerIndex >= room.players.length) {
            room.activePlayerIndex = 0;
          }
          if (room.status === 'selecting_type') {
            delete room.currentTypeSelections[currentPlayerId];
            room.selectorPlayerIds = room.selectorPlayerIds.filter((id) => id !== currentPlayerId);
            if (room.selectorPlayerIds.length === 0) {
              startNextRoundOrTypeSelection(room);
            } else {
              const allRemainingSubmitted = room.selectorPlayerIds.every(
                (id) => room.currentTypeSelections[id] !== undefined
              );
              if (allRemainingSubmitted) {
                finalizeTypeSelectionAndStart(room);
              }
            }
          }
          broadcastToRoom(room, {
            type: 'player_left',
            room: sanitizeRoom(room),
          });
        }
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`poketype-server listening on ${PORT}`);
});
