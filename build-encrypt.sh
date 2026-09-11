#!/bin/bash
# Encrypt the plaintext dashboard (dashboard.html) into the published index.html.
# You are prompted for the password locally — it is never stored in the repo or shell history.
# Usage:  ./build-encrypt.sh          (prompts for password, encrypts + commits + pushes)
#         ./build-encrypt.sh --no-push   (encrypt + commit only)
set -e
cd "$(dirname "$0")"

if [ ! -f dashboard.html ]; then
  echo "ERROR: dashboard.html (plaintext source) not found. It should sit next to this script."
  exit 1
fi

echo "Encrypting dashboard.html -> index.html (you'll be asked for the password)…"
npx --yes staticrypt@3 dashboard.html \
  --template-title "Reap Events Dashboard" \
  --template-instructions "Reap internal — enter the team password to view the events dashboard." \
  --template-color-primary "#4f46e5" \
  --template-color-secondary "#0b1120" \
  --template-button "Unlock" \
  --template-placeholder "Team password" \
  --remember 30 \
  -d .staticrypt-out

cp .staticrypt-out/dashboard.html index.html
rm -rf .staticrypt-out
echo "✓ index.html is now encrypted."

if [ "$1" == "--no-push" ]; then
  echo "Skipping git (--no-push). Review, then commit index.html yourself."
  exit 0
fi

git add index.html
git commit -m "Publish encrypted dashboard" || { echo "Nothing to commit."; exit 0; }
git push
echo "✓ Pushed. Live (password-protected) at https://pearlynyeo-reap.github.io/reap-events-dashboard/"
