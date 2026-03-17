import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on('uncaughtException', (err) => {
  console.error('CRITICAL ERROR:', err);
  if (err.message.includes('__vite-browser-external')) {
    console.error('\n--- WINDOWS RESOLUTION FIX ---');
    console.error('It looks like Vite is trying to resolve Node built-ins for the browser.');
    console.error('Try running the project in a folder without spaces in the path.');
    console.error('Current path:', process.cwd());
    console.error('-------------------------------\n');
  }
});

async function startServer() {
  // Dynamic imports to avoid any resolution issues on Windows
  const express = (await import("express")).default;
  const { Server } = await import("socket.io");

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
  });

  const PORT = 3000;

  // Game state storage
  const rooms = new Map();

  function createDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const values = {
      "♠": ["6", "7", "8", "9", "10", "J", "Q", "K", "A"],
      "♥": ["6", "7", "8", "9", "10", "J", "Q", "K", "A"],
      "♦": ["7", "8", "9", "10", "J", "Q", "K", "A"],
      "♣": ["7", "8", "9", "10", "J", "Q", "K", "A"],
    };
    
    const deck = [];
    for (const suit of suits) {
      for (const value of values[suit as keyof typeof values]) {
        deck.push({ suit, value, type: 'normal' });
      }
    }
    deck.push({ suit: "Joker", value: "Black", type: 'joker' });
    deck.push({ suit: "Joker", value: "Red", type: 'joker' });
    
    return deck.sort(() => Math.random() - 0.5);
  }

  function evaluateTrick(cards: any[], trumpSuit: string) {
    const leadSuit = cards[0].suit;
    
    const sorted = [...cards].sort((a, b) => {
      // Jokers
      if (a.type === 'joker' && !a.isBurned) {
        if (b.type === 'joker' && !b.isBurned) {
          return a.value === 'Red' ? -1 : 1;
        }
        return -1;
      }
      if (b.type === 'joker' && !b.isBurned) return 1;

      // Trump
      if (a.suit === trumpSuit && b.suit !== trumpSuit) return -1;
      if (b.suit === trumpSuit && a.suit !== trumpSuit) return 1;

      // Lead suit
      if (a.suit === leadSuit && b.suit !== leadSuit) return -1;
      if (b.suit === leadSuit && a.suit !== leadSuit) return 1;

      // Value comparison
      const values = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
      return values.indexOf(b.value) - values.indexOf(a.value);
    });

    return sorted[0];
  }

  io.on("connection", (socket) => {
    // Host a new game
    socket.on("hostGame", (data) => {
      const playerName = typeof data === 'string' ? data : data.playerName;
      const isSandbox = typeof data === 'object' ? data.isSandbox : false;
      const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      socket.join(roomCode);
      
      const players: any[] = [{ id: socket.id, name: playerName, cards: [], tricks: 0 }];
      if (isSandbox) {
        players.push({ id: 'bot1', name: 'Bot 1', cards: [], tricks: 0, isBot: true });
        players.push({ id: 'bot2', name: 'Bot 2', cards: [], tricks: 0, isBot: true });
        players.push({ id: 'bot3', name: 'Bot 3', cards: [], tricks: 0, isBot: true });
      }

      const gameState = {
        roomCode,
        isSandbox,
        hostId: socket.id,
        players,
        tableCards: [],
        gameStarted: false,
        phase: 'WAITING', // WAITING, BIDDING, TRUMP_SELECTION, PLAYING, ROUND_OVER, GAME_OVER
        turnIndex: 0,
        dealerIndex: 0,
        highestBid: 0,
        bidWinnerIndex: -1,
        trumpSuit: '',
        roundNumber: 1,
        gameRoundNumber: 1,
        trickWinnerId: '',
        history: [],
        team1Score: 0,
        team2Score: 0,
        lastRoundResult: null
      };
      rooms.set(roomCode, gameState);
      socket.emit("gameHosted", gameState);
    });

    // Rejoin game
    socket.on("rejoinGame", ({ roomCode, playerName }) => {
      const gameState = rooms.get(roomCode);
      if (!gameState) {
        socket.emit("error", "Room not found.");
        return;
      }
      const player = gameState.players.find((p: any) => p.name === playerName);
      if (!player) {
        socket.emit("error", "Player not found in this room.");
        return;
      }
      
      // Update socket id
      player.id = socket.id;
      socket.join(roomCode);
      socket.emit("gameUpdate", gameState);
      io.to(roomCode).emit("playerRejoined", { playerName, gameState });
    });

    // Join an existing game
    socket.on("joinGame", ({ roomCode, playerName }) => {
      const gameState = rooms.get(roomCode);
      if (!gameState || gameState.players.length >= 4 || gameState.gameStarted) {
        socket.emit("error", "Cannot join room. It might be full or already started.");
        return;
      }
      socket.join(roomCode);
      gameState.players.push({ id: socket.id, name: playerName, cards: [], tricks: 0 });
      io.to(roomCode).emit("playerJoined", gameState);
    });

    // Start the game
    socket.on("startGame", (roomCode) => {
      const gameState = rooms.get(roomCode);
      if (!gameState || gameState.players[0].id !== socket.id) return;
      
      if (gameState.phase === 'GAME_OVER') {
        gameState.team1Score = 0;
        gameState.team2Score = 0;
        gameState.gameRoundNumber = 1;
        gameState.history = [];
      }

      gameState.gameStarted = true;
      gameState.phase = 'BIDDING';
      gameState.turnIndex = (gameState.dealerIndex + 1) % gameState.players.length;
      gameState.highestBid = 0;
      gameState.bidWinnerIndex = -1;
      
      const deck = createDeck();
      gameState.players.forEach((player: any, i: number) => {
        player.cards = deck.splice(0, 9);
        player.tricks = 0;
        const hasRed = player.cards.some((c: any) => c.type === 'joker' && c.value === 'Red');
        const hasBlack = player.cards.some((c: any) => c.type === 'joker' && c.value === 'Black');
        player.hasBothJokers = hasRed && hasBlack;
        player.playedRedJoker = false;
        player.playedBlackJoker = false;
      });
      
      io.to(roomCode).emit("gameUpdate", gameState);
    });

    // Handle Bidding
    socket.on("placeBid", ({ roomCode, bid }) => {
      const gameState = rooms.get(roomCode);
      if (!gameState || (gameState.phase !== 'BIDDING' && gameState.phase !== 'DEALER_FORCED_BID')) return;
      
      const currentPlayerIndex = gameState.turnIndex;
      const isHostPlayingForBot = gameState.isSandbox && socket.id === gameState.hostId && gameState.players[currentPlayerIndex].isBot;
      if (gameState.players[currentPlayerIndex].id !== socket.id && !isHostPlayingForBot) return;

      if (gameState.phase === 'DEALER_FORCED_BID') {
        gameState.highestBid = bid;
        gameState.bidWinnerIndex = gameState.dealerIndex;
        gameState.phase = 'TRUMP_SELECTION';
        gameState.turnIndex = gameState.bidWinnerIndex;
      } else {
        if (bid !== 0) { // 0 means pass
          if (bid > gameState.highestBid) {
            gameState.highestBid = bid;
            gameState.bidWinnerIndex = gameState.turnIndex;
          }
        }

        gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;

        // Check if bidding is over (everyone has had a turn)
        const biddingFinished = gameState.turnIndex === (gameState.dealerIndex + 1) % gameState.players.length;
        
        if (biddingFinished) {
          gameState.phase = 'TRUMP_SELECTION';
          gameState.turnIndex = gameState.bidWinnerIndex;
        } else if (gameState.turnIndex === gameState.dealerIndex && gameState.highestBid === 0) {
          gameState.phase = 'DEALER_FORCED_BID';
        }
      }
      
      io.to(roomCode).emit("gameUpdate", gameState);
    });

    // Handle Trump Selection
    socket.on("selectTrump", ({ roomCode, suit }) => {
      const gameState = rooms.get(roomCode);
      if (!gameState || gameState.phase !== 'TRUMP_SELECTION') return;
      const isHostPlayingForBot = gameState.isSandbox && socket.id === gameState.hostId && gameState.players[gameState.bidWinnerIndex].isBot;
      if (gameState.players[gameState.bidWinnerIndex].id !== socket.id && !isHostPlayingForBot) return;

      gameState.trumpSuit = suit;
      gameState.phase = 'PLAYING';
      gameState.roundNumber = 1;
      gameState.turnIndex = (gameState.bidWinnerIndex + 1) % gameState.players.length; // Player after chooser starts the first trick
      
      io.to(roomCode).emit("gameUpdate", gameState);
    });

    // Handle Card Play
    socket.on("playCard", ({ roomCode, cardIndex }) => {
      const gameState = rooms.get(roomCode);
      if (!gameState || gameState.phase !== 'PLAYING') return;
      
      let playerIndex = gameState.players.findIndex(p => p.id === socket.id);
      if (gameState.isSandbox && socket.id === gameState.hostId && gameState.players[gameState.turnIndex].isBot) {
        playerIndex = gameState.turnIndex;
      }
      if (playerIndex !== gameState.turnIndex) return;

      const player = gameState.players[playerIndex];
      const card = player.cards[cardIndex];

      // Bidding 8 Rule
      if (gameState.highestBid === 8 && gameState.roundNumber === 1 && gameState.tableCards.length === 0) {
        const isTrumpCard = card.suit === gameState.trumpSuit || card.type === 'joker';
        if (!isTrumpCard) {
          const hasTrump = player.cards.some((c: any) => c.suit === gameState.trumpSuit || c.type === 'joker');
          if (hasTrump) {
            socket.emit("error", `You must lead with a trump card because the bid was 8`);
            return;
          }
        }
      }

      // Following Suit Rule
      if (gameState.tableCards.length > 0 && card.type !== 'joker') {
        const leadCard = gameState.tableCards[0];
        let demandedSuit = leadCard.suit;
        
        if (leadCard.type === 'joker') {
          demandedSuit = gameState.trumpSuit;
        }

        if (card.suit !== demandedSuit) {
          const hasDemandedSuit = player.cards.some((c: any) => c.suit === demandedSuit && c.type !== 'joker');
          if (hasDemandedSuit) {
            socket.emit("error", `You must follow suit (${demandedSuit})`);
            return;
          }
        }
      }

      // Joker Rules
      let isBurned = false;
      let burnReason = `${card.value} Joker Burned by ${player.name}`;
      if (card.type === 'joker') {
        if (gameState.highestBid <= 6 && player.hasBothJokers) {
          if (card.value === 'Red') {
            if (!player.playedBlackJoker) {
              isBurned = true;
              burnReason = `Red Joker Burned by ${player.name} (Played before Black Joker on bid <= 6)`;
            } else {
              isBurned = false;
            }
          } else if (card.value === 'Black') {
            isBurned = false;
          }
        } else {
          if (card.value === 'Black') {
            const isLeading = gameState.tableCards.length === 0;
            if (isLeading) {
              const canLeadBlackJoker = player.hasBothJokers && gameState.highestBid >= 7 && player.playedRedJoker;
              if (!canLeadBlackJoker) {
                isBurned = true;
                burnReason = `Black Joker Opening Violation by ${player.name} (Requires Both Jokers, Bid 7+, Red Joker played first)`;
              }
            } else {
              if (player.hasBothJokers && player.playedRedJoker) {
                isBurned = false;
              } else if (gameState.roundNumber >= 4) {
                isBurned = true;
                burnReason = `Black Joker Burned by ${player.name} (Played in Round ${gameState.roundNumber} without Both Jokers and Red played first)`;
              }
            }
          }
          
          if (card.value === 'Red') {
            if (player.hasBothJokers) {
              isBurned = false;
            } else {
              const blackJokerPlayed = gameState.history.some((trick: any) => 
                trick.cards.some((c: any) => c.type === 'joker' && c.value === 'Black' && !c.isBurned)
              );
              const blackJokerOnTable = gameState.tableCards.some((c: any) => c.type === 'joker' && c.value === 'Black' && !c.isBurned);
              
              if (!blackJokerPlayed && !blackJokerOnTable) {
                isBurned = true;
                burnReason = `Red Joker Burned by ${player.name} (Played before Black Joker)`;
              }
            }
          }
        }

        if (card.value === 'Red') player.playedRedJoker = true;
        if (card.value === 'Black') player.playedBlackJoker = true;
      }

      player.cards.splice(cardIndex, 1);
      gameState.tableCards.push({ ...card, playedBy: player.name, playerId: player.id, isBurned });

      if (isBurned) {
        // End round immediately
        gameState.phase = 'ROUND_OVER';
        const playingTeam = (playerIndex % 2 === 0) ? 1 : 2;
        const opposingTeam = playingTeam === 1 ? 2 : 1;

        let team1RoundScore = opposingTeam === 1 ? 15 : 0;
        let team2RoundScore = opposingTeam === 2 ? 15 : 0;

        gameState.team1Score += team1RoundScore;
        gameState.team2Score += team2RoundScore;

        // "cards are redistributed to the team with fewer points"
        let nextDealerTeam = gameState.team1Score < gameState.team2Score ? 1 : (gameState.team2Score < gameState.team1Score ? 2 : opposingTeam);
        gameState.dealerIndex = nextDealerTeam === 1 ? 0 : 1;
        gameState.gameRoundNumber++;

        gameState.lastRoundResult = {
          team1Tricks: 0,
          team2Tricks: 0,
          biddingTeam: (gameState.bidWinnerIndex % 2 === 0) ? 1 : 2,
          highestBid: gameState.highestBid,
          team1RoundScore,
          team2RoundScore,
          reason: `${card.value} Joker Burned by ${player.name}`
        };

        if (gameState.team1Score >= 56 || gameState.team2Score >= 56) {
          gameState.phase = 'GAME_OVER';
        }

        io.to(roomCode).emit("gameUpdate", gameState);
        return;
      }

      // Move turn
      gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;

      // Check if trick is over
      if (gameState.tableCards.length === gameState.players.length) {
        // Evaluate trick winner
        const winnerCard = evaluateTrick(gameState.tableCards, gameState.trumpSuit);
        const winnerPlayer = gameState.players.find(p => p.id === winnerCard.playerId);
        if (winnerPlayer) winnerPlayer.tricks++;
        
        gameState.history.push({ round: gameState.roundNumber, cards: [...gameState.tableCards], winner: winnerPlayer?.name });
        
        // Winner of trick starts next trick
        gameState.turnIndex = gameState.players.findIndex(p => p.id === winnerCard.playerId);
        
        // Wait a bit before clearing table so players can see
        setTimeout(() => {
          gameState.tableCards = [];
          gameState.roundNumber++;
          
          // Check if round is over (9 tricks)
          if (gameState.roundNumber > 9) {
            gameState.phase = 'ROUND_OVER';
            gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;
            
            const team1Tricks = gameState.players[0].tricks + gameState.players[2].tricks;
            const team2Tricks = gameState.players[1].tricks + gameState.players[3].tricks;
            
            const biddingTeam = (gameState.bidWinnerIndex % 2 === 0) ? 1 : 2;
            
            let team1RoundScore = 0;
            let team2RoundScore = 0;
            
            let penaltyMultiplier = 1;
            if (gameState.highestBid === 6 && gameState.gameRoundNumber > 1) {
              penaltyMultiplier = 2;
            }

            if (biddingTeam === 1) {
              if (team1Tricks >= gameState.highestBid) {
                team1RoundScore = team1Tricks;
                team2RoundScore = 0;
              } else {
                team1RoundScore = 0;
                team2RoundScore = gameState.highestBid * penaltyMultiplier; // Penalty for failing bid
              }
            } else {
              if (team2Tricks >= gameState.highestBid) {
                team2RoundScore = team2Tricks;
                team1RoundScore = 0;
              } else {
                team2RoundScore = 0;
                team1RoundScore = gameState.highestBid * penaltyMultiplier; // Penalty for failing bid
              }
            }
            
            gameState.team1Score += team1RoundScore;
            gameState.team2Score += team2RoundScore;
            gameState.gameRoundNumber++;
            
            gameState.lastRoundResult = {
              team1Tricks,
              team2Tricks,
              biddingTeam,
              highestBid: gameState.highestBid,
              team1RoundScore,
              team2RoundScore
            };

            if (gameState.team1Score >= 56 || gameState.team2Score >= 56) {
              gameState.phase = 'GAME_OVER';
            }
          }
          io.to(roomCode).emit("gameUpdate", gameState);
        }, 2000);
      }

      io.to(roomCode).emit("gameUpdate", gameState);
    });
  });

  // Raw source handler for ZIP export
  app.get("/src/*", (req, res, next) => {
    if (req.headers['x-raw-source'] === 'true') {
      const filePath = path.join(__dirname, req.path);
      return res.sendFile(filePath);
    }
    next();
  });

  app.get("/server.ts", (req, res, next) => {
    if (req.headers['x-raw-source'] === 'true') {
      return res.sendFile(path.join(__dirname, "server.ts"));
    }
    next();
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
