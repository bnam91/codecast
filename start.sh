#!/bin/bash
export PATH="/Users/a1/.nvm/versions/node/v24.11.1/bin:$PATH"
cd /Users/a1/claude-commander
exec node_modules/.bin/electron . --remote-debugging-port=9340
