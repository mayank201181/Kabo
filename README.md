# Kabo

The Kabo (Cabo) memory card game for 2–10 players, played online on phones. One person creates a room and shares the link on WhatsApp, and everyone else opens it and types their name. There is nothing to install and no accounts.

## House rules (as built)

- **One 52-card deck.** A = 1, 2–10 = face value, J = 11, Q = 12, K♠ K♣ (hukum, chidi) = 13, K♥ K♦ (paan, eent) = −1.
- **Deal:** 4 cards face-down each. Look at any 2 once, then remember them.
- **Your turn**, one of:
  - Draw from the deck, then keep it (swap it for one of your cards), match it, or discard it. You always draw from the deck; nobody picks up a card someone else threw away.
  - Call **Kabo**. Everyone else gets one last turn.
- **Powers** (only for a card drawn from the deck and discarded):
  - 7, 8: peek at one of your cards.
  - 9, 10: spy on someone else's card.
  - J, Q: blind-swap one of yours with one of theirs.
  - K♠, K♣: look at one of yours and one of theirs, then swap or not. Red Kings can do the same, but nobody will because they're worth −1.
- **Matching:** draw a card from the deck with the same rank as one of yours (a 2 when you know you have a 2) and you can throw both on the discard pile, so your hand gets smaller. You can match more than one card at a time. A card that doesn't match is turned face-up and costs a penalty card. Get rid of all your cards and the round ends.
- **Matching out of turn (snap):** whenever a card lands on the discard pile, anyone can throw a card of the same rank on it, even out of turn. Only the first person gets it; anyone later, or with the wrong card, takes a penalty card. You can also throw someone else's card if you know it (e.g. you spied on it), then give them one of yours in its place. The Kabo caller's cards are final.
- **Deck runs out:** the discard pile is reshuffled into a new deck.
- **Scoring:**
  - Your score for the round is the total of your cards.
  - If you call Kabo and have the lowest total (ties count), you score 0, or your total if it is negative.
  - If you call Kabo and someone is lower, you score your total + 10.
  - Kamikaze (exactly Q, Q, K♠, K♣) scores 0 for you and half the target for everyone else.
  - Landing exactly on the target drops you to half of it, once per game.
- **Game end:** play to **50** (or 100). The game ends when someone goes over, and the lowest total wins.

The host can switch these in the lobby: target 50/100, turn timer, reshuffle vs. end the round, picking up the top discard (the official rule, off by default) and whether those pickups stay face-up, whether red Kings have the power, locking the Kabo caller's cards, matching out of turn, and Kamikaze.

## Features

- **Rooms:** 4-letter room codes and share links (`https://…/ABCD`), with WhatsApp, Share and Copy link buttons.
- **Computer players:** add them to fill seats or to practise alone.
- **Hidden cards stay hidden:** the server decides everything and sends each phone only the cards that player is allowed to see.
- **Reconnecting:** a reload or a dropped connection puts you back in your seat. While a player is offline, their turns pass after 30 seconds.
- **Host controls:** turn timer, pause/resume, skip a turn, remove a player, make someone else host, and end the game. The host role moves to someone else if the host is offline for 30 seconds.
- **Seat takeover:** if a phone dies, the person can rejoin on another device and take their seat back once the host approves.
- **On screen:** a running game log, scores per round, a round-results breakdown and a How-to-play page.
- **Phone extras:** sounds, vibration and card animations. The screen stays awake during a game.

## Put it online (Render, about 10 minutes)

1. Merge the pull request so the code is on `main`.
2. Go to [dashboard.render.com](https://dashboard.render.com) and sign up with GitHub. Let Render see the `kabo` repo.
3. Click **New → Blueprint**, pick `kabo`, then click **Apply**. `render.yaml` sets everything up: Node, Singapore region, free plan.
4. When the deploy finishes (a few minutes), open the `https://kabo-….onrender.com` link it shows. That's the link to share.

Notes:

- **The free plan sleeps** after 15 minutes with nobody connected, and the first visit then takes about a minute to wake it. Render can also restart free servers, which ends games in progress. For game nights, change the instance type to Starter (about $7/month) under the service's Settings, and switch back to free afterwards if you like.
- **Every merge to `main` redeploys** and restarts the server, which ends games in progress. Don't deploy during a game.
- Games live in memory only. Nothing is stored and there are no accounts.

## Run it locally

```sh
npm install
npm start          # http://localhost:3000
npm test           # rules, randomised games and socket tests
```

Phones on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`.

## Code map

- `server/game.js`: the rules engine, a pure state machine. `viewFor(player)` is the only way state reaches a client.
- `server/bot.js`: computer players. They only use what a human in their seat would know.
- `server/rooms.js`: rooms, seats, host controls, turn timers, reconnects and the socket API.
- `server/index.js`: the Express + Socket.IO server.
- `public/`: the phone web app, plain ES modules with no build step.
- `test/`: unit tests, randomised fuzz games that check no card is ever lost or leaked, and end-to-end socket tests.
