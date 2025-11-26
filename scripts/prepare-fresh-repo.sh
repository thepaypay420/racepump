#!/bin/bash

# Script to prepare a fresh repository for public release
# This removes all git history and creates a clean initial commit

set -e

echo "🔒 Preparing fresh repository for public release..."
echo ""

# Check if we're in a git repository
if [ ! -d .git ]; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

# Warn user
echo "⚠️  WARNING: This will remove ALL git history!"
echo "⚠️  Make sure you have a backup or have pushed to a remote!"
echo ""
read -p "Continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  Warning: You have uncommitted changes."
    echo "These will be included in the fresh commit."
    read -p "Continue anyway? (yes/no): " confirm2
    if [ "$confirm2" != "yes" ]; then
        echo "Aborted."
        exit 1
    fi
fi

# Verify sensitive files are not tracked
echo ""
echo "🔍 Checking for sensitive files..."
SENSITIVE=$(git ls-files | grep -E "(\.b58|keypair|private|secret|\.env$|\.env\.local$|\.env\.production$)" || true)

if [ -n "$SENSITIVE" ]; then
    echo "❌ Found sensitive files that are tracked:"
    echo "$SENSITIVE"
    echo ""
    echo "Please ensure these are in .gitignore and remove them from git:"
    echo "  git rm --cached <file>"
    exit 1
fi

echo "✅ No sensitive files found in tracked files"
echo ""

# Remove git history
echo "🗑️  Removing git history..."
rm -rf .git

# Initialize fresh repository
echo "🆕 Initializing fresh repository..."
git init

# Add all files
echo "📦 Adding all files..."
git add .

# Create initial commit
echo "💾 Creating initial commit..."
git commit -m "Initial commit: RacePump - Solana parimutuel betting dApp

Features:
- SOL betting with 5% rake (3% treasury, 2% jackpot)
- RACESwap token swap with 1% reflection buys and 0.2% treasury fee
- Live race animations with provably fair settlement
- Edge Points reward system for power users
- Mainnet deployment ready

Technical Stack:
- Solana mainnet
- Jupiter swap integration
- Anchor program (RACESwap V3)
- Postgres persistence
- React + TypeScript frontend
- Express backend"

echo ""
echo "✅ Fresh repository created!"
echo ""
echo "📋 Next steps:"
echo "1. Create a new repository on GitHub (or your Git host)"
echo "2. Add the remote: git remote add origin <your-repo-url>"
echo "3. Push: git branch -M main && git push -u origin main"
echo "4. Verify: git log (should show only one commit)"
echo ""
echo "🔍 Verify no sensitive files:"
echo "   git ls-files | grep -E '(\.b58|keypair|private|secret|\.env)'"
echo "   (should return nothing)"
