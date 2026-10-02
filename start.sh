#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
if [ ! -f accounts.config.json ]; then
  cp accounts.config.example.json accounts.config.json
  echo "Заполни accounts.config.json и запусти снова."; exit 1
fi
node src/server.js
