# 🏆 PSN Trophy Leaderboard Discord Bot

A Discord bot that creates a dynamic leaderboard based on PlayStation Network (PSN) trophies. Users can register their PSN usernames, and the bot fetches their trophy stats using the [psn-api](https://www.npmjs.com/package/psn-api), then ranks them by number of Platinums, Golds, Silvers, and Bronzes.

## ✨ Features

- Slash command `/addpsn` to register your PSN username
- `/leaderboard` to view the trophy ranking
- Uses official PSN API via `psn-api` npm package
- Persistent storage via JSON file
- Sorted by Plat > Gold > Silver > Bronze

## 🚀 Getting Started

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/psn-leaderboard-bot.git
cd psn-leaderboard-bot
