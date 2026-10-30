#!/bin/sh
# Запуск игры на хостинге одной командой:  ./start.sh
# Последовательно выполняет npm install, затем npm start.
set -e

echo "==> npm install"
npm install

echo "==> npm start"
exec npm start
