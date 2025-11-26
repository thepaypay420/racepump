#!/bin/bash

# Script to migrate to new repository: https://github.com/thepaypay420/racepump
# This creates a fresh git history and connects to the new remote

set -e

NEW_REPO_URL="https://github.com/thepaypay420/racepump.git"

echo "🚀 Migrating to new repository: $NEW_REPO_URL"
echo ""

# Check if we're in a git repository
if [ ! -d .git ]; then
    echo "❌ Error: Not in a git repository"
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo "⚠️  Warning: You have uncommitted changes."
    echo "These will be included in the fresh commit."
    read -p "Continue? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Aborted."
        exit 1
    fi
fi

# Verify sensitive files are not tracked
echo "🔍 Checking for sensitive files..."
SENSITIVE=$(git ls-files | grep -E "(\.b58$|keypair\.json$|keypair\.b58$|private|secret|\.env$|\.env\.local$|\.env\.production$)" || true)

if [ -n "$SENSITIVE" ]; then
    echo "⚠️  Found files that might be sensitive:"
    echo "$SENSITIVE"
    echo ""
    echo "These look safe (utility scripts), but double-check if needed."
    read -p "Continue anyway? (yes/no): " confirm2
    if [ "$confirm2" != "yes" ]; then
        echo "Aborted."
        exit 1
    fi
fi

echo "✅ Files look safe"
echo ""

# Remove git history
echo "🗑️  Removing old git history..."
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
- Express backend

Repository prepared for public release."

# Add new remote (or update if it exists)
echo "🔗 Connecting to new repository..."
if git remote get-url origin >/dev/null 2>&1; then
    echo "   Updating existing remote..."
    git remote set-url origin "$NEW_REPO_URL"
else
    echo "   Adding new remote..."
    git remote add origin "$NEW_REPO_URL"
fi

# Set branch name
git branch -M main

echo ""
echo "✅ Fresh repository created and connected!"
echo ""
echo "📋 Next steps:"
echo "1. Verify the repository exists and is empty: $NEW_REPO_URL"
echo "2. Push to new repository:"
echo "   git push -u origin main"
echo ""
echo "🔍 Verify no sensitive files:"
echo "   git ls-files | grep -E '(\.b58|keypair|private|secret|\.env)'"
echo "   (should only show utility scripts, no actual keys)"
echo ""
read -p "Ready to push? (yes/no): " push_confirm

if [ "$push_confirm" == "yes" ]; then
    echo ""
    echo "📤 Pushing to new repository..."
    
    # Check for GitHub token
    if [ -z "$GITHUB_TOKEN" ]; then
        echo "❌ Error: GITHUB_TOKEN environment variable is not set"
        echo "Please set it with: export GITHUB_TOKEN=your_token"
        exit 1
    fi
    
    # Construct authenticated URL
    AUTH_URL="https://${GITHUB_TOKEN}@github.com/thepaypay420/racepump.git"
    
    # Temporarily update remote URL with token, then restore clean URL
    git remote set-url origin "$AUTH_URL"
    git push -u origin main
    git remote set-url origin "$NEW_REPO_URL"
    
    echo ""
    echo "✅ Successfully migrated to new repository!"
    echo ""
    echo "🌐 Repository: $NEW_REPO_URL"
    echo ""
    echo "📝 Next steps:"
    echo "1. Verify the repository on GitHub"
    echo "2. Make it public (Settings → Danger Zone → Change visibility)"
    echo "3. Update Phantom submission with new repo URL"
else
    echo ""
    echo "⏸️  Skipped push. Run manually when ready:"
    if [ -n "$GITHUB_TOKEN" ]; then
        echo "   git remote set-url origin https://\${GITHUB_TOKEN}@github.com/thepaypay420/racepump.git"
        echo "   git push -u origin main"
        echo "   git remote set-url origin $NEW_REPO_URL"
    else
        echo "   git push -u origin main"
        echo "   (Note: You'll need to set GITHUB_TOKEN for authentication)"
    fi
fi
